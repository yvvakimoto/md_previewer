fn main() {
    #[cfg(windows)]
    {
        println!("cargo:rerun-if-changed=app.rc");
        println!("cargo:rerun-if-changed=assets/icon.ico");
        embed_resource::compile("app.rc", embed_resource::NONE);
    }
}
