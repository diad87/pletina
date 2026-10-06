fn main() {
  // El manifiesto de Windows (pide comctl32 v6, que usan los diálogos) se incrusta con el enlazador
  // en todos los ejecutables, también en los de los tests: sin él, Windows les da la versión
  // antigua de comctl32, sin `TaskDialogIndirect`, y no llegan ni a arrancar.
  let msvc = std::env::var("CARGO_CFG_TARGET_ENV").is_ok_and(|e| e == "msvc");
  if msvc {
    let manifest = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("windows-app-manifest.xml");
    println!("cargo:rerun-if-changed=windows-app-manifest.xml");
    println!("cargo:rustc-link-arg=/MANIFEST:EMBED");
    println!("cargo:rustc-link-arg=/MANIFESTINPUT:{}", manifest.display());
  }
  let windows = if msvc {
    tauri_build::WindowsAttributes::new_without_app_manifest()
  } else {
    tauri_build::WindowsAttributes::new()
  };
  tauri_build::try_build(tauri_build::Attributes::new().windows_attributes(windows)).expect("tauri-build");
}
