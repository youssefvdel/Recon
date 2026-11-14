# Sidecar fonts (optional)

The Slint UI references the `Outfit`, `DM Sans` and `JetBrains Mono` families
(tokens.slint). The sidecar registers any `*.ttf`/`*.otf` dropped in THIS
directory at startup; with no files it logs `registered: 0` and Slint falls
back to system fonts.

To bundle real fonts: download the OFL-licensed sources and place the files
here (names must stay the families' own — registration uses the internal
name, not the filename):

- Outfit — https://github.com/google/fonts/tree/main/ofl/outfit
- DM Sans — https://github.com/google/fonts/tree/main/ofl/dmsans
- JetBrains Mono — https://github.com/JetBrains/JetBrainsMono (OFL-1.1)

NEVER commit non-OFL binaries here. Whatever ships must be reproducible from
the links above.
