//! In-process HTTPS transport for Riot's APIs (both the local Riot Client and
//! Riot's remote game servers).
//!
//! Why this exists: every API call used to spawn a short-lived `curl.exe`.
//! `CreateProcess` on Windows costs tens of milliseconds of CPU each, and the
//! live poll fires several calls per cycle per WebView window, so process
//! creation — not the network — was the app's single largest CPU cost.
//!
//! Transport choices, deliberately small:
//!   - TLS via `native-tls`, which is Schannel on Windows: the OS trust store,
//!     no bundled TLS stack, no libclang/cmake build requirement.
//!   - One connection per request, `Connection: close`, body framed by
//!     read-to-EOF. No pooling: the win was removing `CreateProcess`, not
//!     shaving a TLS handshake. Pooling would add stale-socket retry bugs for
//!     no meaningful extra gain.
//!   - Loopback callers pass `accept_invalid_certs` to mirror the old
//!     `curl -k` against the Riot Client's self-signed cert.

use std::io::{Read, Write};
use std::net::{TcpStream, ToSocketAddrs};
use std::time::Duration;

use native_tls::{TlsConnector, TlsStream};

const HTTPS_PORT: u16 = 443;

/// The `Host` header omits the port when it is the scheme default, matching
/// what curl sent for both the 443 game servers and the loopback client.
fn host_header(host: &str, port: u16) -> String {
    if port == HTTPS_PORT {
        host.to_string()
    } else {
        format!("{}:{}", host, port)
    }
}

/// One request, described the way the caller used to describe its curl argv.
/// Every field maps 1:1 onto a flag or header the old call passed.
pub struct Request<'a> {
    /// Host only — no scheme, no port. Used for DNS, SNI and the `Host` header.
    pub host: &'a str,
    /// Remote calls are 443; the Riot Client's loopback port comes from its lockfile.
    pub port: u16,
    /// Absolute path, already validated by the caller.
    pub path: &'a str,
    pub method: &'a str,
    /// Sent verbatim, in order.
    pub headers: &'a [(String, String)],
    pub body: Option<&'a str>,
    /// The old `-u user:pass`.
    pub basic_auth: Option<String>,
    /// The old `-k`. Also disables hostname matching, which `curl -k` does.
    pub accept_invalid_certs: bool,
    /// The old `--connect-timeout`.
    pub connect_timeout: Duration,
    /// The old `--max-time`. Applied as the socket read/write timeout.
    pub max_time: Duration,
}

pub struct Response {
    pub status: u16,
    pub body: String,
}

/// Send one request. `Err` means no HTTP response was read at all — the same
/// condition that made curl exit non-zero, which is how callers tell a
/// transport failure apart from a 4xx/5xx body.
pub fn send(req: &Request<'_>) -> Result<Response, String> {
    let stream = connect(req.host, req.port, req.connect_timeout)?;
    stream
        .set_read_timeout(Some(req.max_time))
        .map_err(|e| e.to_string())?;
    stream
        .set_write_timeout(Some(req.max_time))
        .map_err(|e| e.to_string())?;

    let mut tls = tls_connect(req, stream)?;
    let wire = encode(req);
    tls.write_all(wire.as_bytes()).map_err(|e| e.to_string())?;
    tls.flush().map_err(|e| e.to_string())?;

    // `Connection: close` means EOF delimits the body, so read-to-EOF is a
    // complete frame. A read timeout surfaces here as an error.
    let mut raw = Vec::new();
    tls.read_to_end(&mut raw).map_err(|e| e.to_string())?;
    parse(&raw)
}

fn connect(host: &str, port: u16, timeout: Duration) -> Result<TcpStream, String> {
    let addrs = (host, port).to_socket_addrs().map_err(|e| e.to_string())?;
    let mut last = String::from("no address resolved");
    for addr in addrs {
        match TcpStream::connect_timeout(&addr, timeout) {
            Ok(s) => {
                // Small request/response pairs: Nagle only adds latency.
                let _ = s.set_nodelay(true);
                return Ok(s);
            }
            Err(e) => last = e.to_string(),
        }
    }
    Err(last)
}

fn tls_connect(req: &Request<'_>, stream: TcpStream) -> Result<TlsStream<TcpStream>, String> {
    let mut builder = TlsConnector::builder();
    if req.accept_invalid_certs {
        // `curl -k` skips the chain AND the name check. Both are needed: the
        // Riot Client's self-signed cert is not issued for "127.0.0.1".
        builder.danger_accept_invalid_certs(true);
        builder.danger_accept_invalid_hostnames(true);
    }
    builder
        .build()
        .map_err(|e| e.to_string())?
        .connect(req.host, stream)
        .map_err(|e| e.to_string())
}

fn encode(req: &Request<'_>) -> String {
    let mut s = String::with_capacity(512);
    s.push_str(req.method);
    s.push(' ');
    s.push_str(req.path);
    s.push_str(" HTTP/1.1\r\n");
    s.push_str(&format!("Host: {}\r\n", host_header(req.host, req.port)));
    // curl's implicit default, kept so the wire request matches what Riot saw.
    s.push_str("Accept: */*\r\n");
    for (name, value) in req.headers {
        s.push_str(&format!("{}: {}\r\n", name, value));
    }
    if let Some(auth) = &req.basic_auth {
        s.push_str(&format!(
            "Authorization: Basic {}\r\n",
            base64(auth.as_bytes())
        ));
    }
    if let Some(b) = req.body {
        s.push_str(&format!("Content-Length: {}\r\n", b.len()));
    }
    s.push_str("Connection: close\r\n\r\n");
    if let Some(b) = req.body {
        s.push_str(b);
    }
    s
}

fn parse(raw: &[u8]) -> Result<Response, String> {
    let split = find(raw, b"\r\n\r\n").ok_or("malformed response: no header terminator")?;
    let head = String::from_utf8_lossy(&raw[..split]).to_string();
    let body = &raw[split + 4..];

    let mut lines = head.split("\r\n");
    let status_line = lines.next().ok_or("malformed response: no status line")?;
    let mut fields = status_line.split(' ');
    let _version = fields.next();
    let status: u16 = fields
        .next()
        .ok_or("malformed response: no status code")?
        .parse()
        .map_err(|_| "malformed response: unparsable status code")?;

    let mut chunked = false;
    for line in lines {
        if let Some(i) = line.find(':') {
            let (name, value) = line.split_at(i);
            if name.trim().eq_ignore_ascii_case("transfer-encoding")
                && value.to_ascii_lowercase().contains("chunked")
            {
                chunked = true;
            }
        }
    }

    let bytes = if chunked {
        dechunk(body)?
    } else {
        body.to_vec()
    };
    // Matches the old `String::from_utf8_lossy(&output.stdout)`.
    Ok(Response {
        status,
        body: String::from_utf8_lossy(&bytes).to_string(),
    })
}

fn dechunk(mut src: &[u8]) -> Result<Vec<u8>, String> {
    let mut out = Vec::new();
    loop {
        let nl = find(src, b"\r\n").ok_or("malformed response: truncated chunk header")?;
        let header = String::from_utf8_lossy(&src[..nl]).to_string();
        // chunk-size may carry a `;ext=value` suffix — hex digits come first.
        let size_hex = header.split(';').next().unwrap_or("").trim();
        let size = usize::from_str_radix(size_hex, 16)
            .map_err(|_| "malformed response: unparsable chunk size")?;
        src = &src[nl + 2..];
        if size == 0 {
            return Ok(out);
        }
        if src.len() < size {
            return Err("malformed response: truncated chunk body".to_string());
        }
        out.extend_from_slice(&src[..size]);
        src = &src[size..];
        if src.len() >= 2 && src[..2] == *b"\r\n" {
            src = &src[2..];
        }
    }
}

fn find(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack.windows(needle.len()).position(|w| w == needle)
}

/// Standard base64 (RFC 4648 §4) for the Basic auth header. Hand-rolled rather
/// than pulling a dependency for one call site.
fn base64(input: &[u8]) -> String {
    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(input.len().div_ceil(3) * 4);
    for chunk in input.chunks(3) {
        let b = [
            chunk[0],
            *chunk.get(1).unwrap_or(&0),
            *chunk.get(2).unwrap_or(&0),
        ];
        let n = ((b[0] as u32) << 16) | ((b[1] as u32) << 8) | b[2] as u32;
        out.push(ALPHABET[(n >> 18) as usize & 63] as char);
        out.push(ALPHABET[(n >> 12) as usize & 63] as char);
        out.push(if chunk.len() > 1 {
            ALPHABET[(n >> 6) as usize & 63] as char
        } else {
            '='
        });
        out.push(if chunk.len() > 2 {
            ALPHABET[n as usize & 63] as char
        } else {
            '='
        });
    }
    out
}

/// True when a body means "your token is no good" — the old call sites all
/// sniffed for exactly these markers, since curl reports HTTP errors as a
/// successful exit.
pub fn is_auth_failure(body: &str) -> bool {
    body.contains("\"statusCode\":401")
        || body.contains("\"httpStatus\":401")
        || body.contains("\"statusCode\": 401")
        || body.contains("\"httpStatus\": 401")
        || body.contains("BAD_AUTH")
        || body.contains("EXPIRED_AUTH")
        || body.contains("FORBIDDEN")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn base64_matches_rfc4648_vectors() {
        assert_eq!(base64(b""), "");
        assert_eq!(base64(b"f"), "Zg==");
        assert_eq!(base64(b"fo"), "Zm8=");
        assert_eq!(base64(b"foo"), "Zm9v");
        assert_eq!(base64(b"foob"), "Zm9vYg==");
        assert_eq!(base64(b"fooba"), "Zm9vYmE=");
        assert_eq!(base64(b"foobar"), "Zm9vYmFy");
        // The exact value `curl -u riot:<password>` produced.
        assert_eq!(base64(b"riot:secret"), "cmlvdDpzZWNyZXQ=");
    }

    #[test]
    fn parses_content_length_framed_response() {
        let raw = b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 9\r\n\r\n{\"ok\":1}\n";
        let r = parse(raw).unwrap();
        assert_eq!(r.status, 200);
        assert_eq!(r.body, "{\"ok\":1}\n");
    }

    #[test]
    fn parses_chunked_response_with_extension() {
        let raw = b"HTTP/1.1 404 Not Found\r\nTransfer-Encoding: chunked\r\n\r\n\
                    5;ext=1\r\nhello\r\n6\r\n world\r\n0\r\n\r\n";
        let r = parse(raw).unwrap();
        assert_eq!(r.status, 404);
        assert_eq!(r.body, "hello world");
    }

    #[test]
    fn body_may_contain_blank_lines() {
        // The split must key on the FIRST \r\n\r\n, not the last — the old
        // curl path appended `\n%{http_code}` and split on the last newline.
        let raw = b"HTTP/1.1 200 OK\r\n\r\nline1\n\nline2";
        let r = parse(raw).unwrap();
        assert_eq!(r.status, 200);
        assert_eq!(r.body, "line1\n\nline2");
    }

    #[test]
    fn auth_failure_markers_match_old_sniffing() {
        assert!(is_auth_failure(r#"{"httpStatus":401}"#));
        assert!(is_auth_failure(r#"{"statusCode": 401}"#));
        assert!(is_auth_failure(r#"{"errorCode":"BAD_AUTH"}"#));
        assert!(is_auth_failure(r#"{"message":"EXPIRED_AUTH"}"#));
        assert!(!is_auth_failure(r#"{"statusCode":404}"#));
    }
}
