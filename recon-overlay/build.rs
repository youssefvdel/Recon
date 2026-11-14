fn main() {
    println!("cargo::rerun-if-changed=ui/");
    slint_build::compile("ui/overlay.slint").expect("recon-overlay: ui/overlay.slint must compile");
}
