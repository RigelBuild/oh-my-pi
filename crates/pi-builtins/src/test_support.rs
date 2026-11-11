//! Helpers shared by the crate's unit tests.

use std::{fs, io, path::Path, process::Command};

/// Write `contents` to `path` and make it executable from a child shell.
/// The child avoids inherited write descriptors that can cause `ETXTBSY`.
pub(crate) fn write_exec_script(path: &Path, contents: &str) -> io::Result<()> {
	use std::os::unix::fs::PermissionsExt as _;

	let status = Command::new("/bin/sh")
		.arg("-c")
		.arg(r#"printf '%s' "$1" > "$2""#)
		.arg("sh")
		.arg(contents)
		.arg(path)
		.status()?;
	if !status.success() {
		return Err(io::Error::other(format!("writing {} exited with {status}", path.display())));
	}
	fs::set_permissions(path, fs::Permissions::from_mode(0o755))
}
