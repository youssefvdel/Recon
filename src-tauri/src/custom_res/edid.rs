//! Pure EDID helpers: header check, block checksum, PnP path split/format and
//! the 128-byte base-block patch.
//!
//! No `windows`, registry or filesystem access, so the host-agnostic test crate
//! (`src-tauri/pure`) compiles and tests this exact file by path. The parent
//! module keeps the registry read/write (`EDID`, `EDID_OVERRIDE`) that consumes
//! these bytes, and never forks this logic.

/// The base block is the 128-byte unit every EDID file starts with.
pub(crate) const BASE_BLOCK_LEN: usize = 128;
/// Byte 7 of the header is `0x00`; bytes 0..=6 are the `00 FF FF FF FF FF FF`
/// sync pattern.
pub(crate) const EDID_HEADER: [u8; 8] = [0x00, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0x00];
/// First detailed timing descriptor (the only one this writer patches).
pub(crate) const DTD_OFFSET: usize = 54;
/// The block checksum covers bytes 0..=126 and is stored in byte 127.
pub(crate) const CHECKSUM_OFFSET: usize = 127;
/// 1-byte count of 128-byte extension blocks that follow the base block.
pub(crate) const EXTENSION_COUNT_OFFSET: usize = 126;

/// Checksum byte for a block body (its first 127 bytes): the value that makes
/// the whole 128-byte block sum to 0 mod 256, as every EDID block requires.
pub(crate) fn checksum_byte(body: &[u8]) -> u8 {
    let sum: u32 = body.iter().map(|b| *b as u32).sum();
    ((256 - (sum % 256)) % 256) as u8
}

/// True when one 128-byte block (base or extension) carries a valid checksum.
/// A short slice is never a block, so it is never valid.
pub(crate) fn block_checksum_ok(block: &[u8]) -> bool {
    if block.len() < BASE_BLOCK_LEN {
        return false;
    }
    let sum: u32 = block[..BASE_BLOCK_LEN].iter().map(|b| *b as u32).sum();
    sum % 256 == 0
}

/// Extension-block count declared by byte 126 of the base block.
pub(crate) fn extension_block_count(edid: &[u8]) -> usize {
    edid.get(EXTENSION_COUNT_OFFSET).copied().unwrap_or(0) as usize
}

/// True when `edid` physically holds every block its base header declares.
pub(crate) fn has_all_blocks(edid: &[u8]) -> bool {
    edid.len() >= BASE_BLOCK_LEN && edid.len() >= BASE_BLOCK_LEN * (1 + extension_block_count(edid))
}

pub(crate) fn split_pnp(pnp: &str) -> Option<(String, String)> {
    let t = pnp.trim();
    // Expect DISPLAY\<device>\<instance...>
    let mut parts = t.split('\\');
    let enum_name = parts.next()?.trim();
    if !enum_name.eq_ignore_ascii_case("DISPLAY") {
        return None;
    }
    let dev = parts.next()?.trim().to_string();
    if dev.is_empty() {
        return None;
    }
    let rest: Vec<&str> = parts.collect();
    if rest.is_empty() {
        return None;
    }
    let inst = rest.join("\\").trim().to_string();
    if inst.is_empty() {
        return None;
    }
    Some((dev, inst))
}

pub(crate) fn device_params_path(dev: &str, inst: &str) -> String {
    format!(
        "SYSTEM\\CurrentControlSet\\Enum\\DISPLAY\\{}\\{}\\Device Parameters",
        dev, inst
    )
}

pub(crate) fn override_path(dev: &str, inst: &str) -> String {
    format!("{}\\EDID_OVERRIDE", device_params_path(dev, inst))
}

pub(crate) fn is_valid_edid(edid: &[u8]) -> bool {
    edid.len() >= 128
        && edid[0] == 0x00
        && edid[1] == 0xFF
        && edid[2] == 0xFF
        && edid[3] == 0xFF
        && edid[4] == 0xFF
        && edid[5] == 0xFF
        && edid[6] == 0xFF
        && edid[7] == 0x00
}

/// Minimal single-descriptor patch: copy 128B base, overwrite the first
/// detailed descriptor at offset 54, fix checksum byte 127.
pub fn patch_edid(base: &[u8], timing: [u8; 18]) -> Result<[u8; 128], String> {
    if base.len() < 128 {
        return Err("Base EDID shorter than 128 bytes.".to_string());
    }
    if !is_valid_edid(base) {
        return Err("Base EDID header invalid.".to_string());
    }
    let mut out = [0u8; 128];
    out.copy_from_slice(&base[..128]);
    out[54..72].copy_from_slice(&timing);
    // Fix checksum: sum of all 128 bytes must be 0 mod 256.
    out[CHECKSUM_OFFSET] = checksum_byte(&out[..CHECKSUM_OFFSET]);
    Ok(out)
}
