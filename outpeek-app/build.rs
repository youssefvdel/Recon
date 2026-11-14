fn main() {
    println!("cargo::rerun-if-changed=ui/");
    // Tokens/components are shared with the HUD crate, never copied: the
    // include path makes `tokens.slint` and `components/plate.slint` resolve
    // out of `outpeek-overlay/ui`.
    println!("cargo::rerun-if-changed=../outpeek-overlay/ui/");
    // The Settings page reports the target triple the compiler actually built
    // for. Guessing it from `std::env::consts` would be a different string.
    if let Ok(target) = std::env::var("TARGET") {
        println!("cargo::rustc-env=OUTPEEK_TARGET={target}");
    }
    let config = slint_build::CompilerConfiguration::new()
        .with_include_paths(vec![std::path::PathBuf::from("../outpeek-overlay/ui")]);
    slint_build::compile_with_config("ui/app.slint", config)
        .expect("outpeek-app: ui/app.slint must compile");
}
