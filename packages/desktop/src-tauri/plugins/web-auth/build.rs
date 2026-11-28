const COMMANDS: &[&str] = &["authenticate", "sign_in_with_apple"];

fn main() {
    tauri_plugin::Builder::new(COMMANDS).ios_path("ios").build();
}
