//! `.mdx` bundle support.
//!
//! An `.mdx` file is a ZIP archive bundling a Markdown document together with
//! its relative-path resources (images / CSV / video / …). The rest of the app
//! is built entirely around real filesystem paths (`current_dir`, the
//! `/userfile/` protocol route, the `notify` watcher, editor pairing), so the
//! simplest robust approach is to **extract the archive into a temp directory
//! and treat the extracted entry `.md` as an ordinary file**. Everything else
//! (image/CSV/video serving, rendering, export) then works unchanged.
//!
//! [`MdxSession`] keeps the temp dir alive (auto-deleted on `Drop`) and remembers
//! the original `.mdx` path so saves can be repacked back into it.

use std::fs;
use std::io::{self, Write};
use std::path::{Component, Path, PathBuf};

/// True if `p` has the `.mdx` extension (case-insensitive).
pub fn is_mdx_ext(p: &Path) -> bool {
    p.extension()
        .and_then(|e| e.to_str())
        .map(|e| e.eq_ignore_ascii_case("mdx"))
        .unwrap_or(false)
}

/// An open `.mdx` bundle: the original archive path, the temp dir it was
/// extracted into (kept alive for the lifetime of the session), and the path to
/// the extracted entry Markdown file.
pub struct MdxSession {
    pub mdx_path: PathBuf,
    /// Held to keep the extraction directory alive; removed on `Drop`.
    pub temp: tempfile::TempDir,
    pub entry: PathBuf,
}

fn is_md(p: &Path) -> bool {
    p.extension()
        .and_then(|e| e.to_str())
        .map(|e| e.eq_ignore_ascii_case("md") || e.eq_ignore_ascii_case("markdown"))
        .unwrap_or(false)
}

/// Decide which extracted `.md` is the document entry: a root-level `index.md`,
/// then a root-level `README.md` (both case-insensitive), else — if there is
/// exactly one Markdown file anywhere in the bundle — that one.
fn pick_entry(md_files: &[PathBuf]) -> Option<PathBuf> {
    let root_named = |target: &str| {
        md_files
            .iter()
            .find(|p| {
                p.components().count() == 1
                    && p.file_name()
                        .and_then(|n| n.to_str())
                        .map(|n| n.eq_ignore_ascii_case(target))
                        .unwrap_or(false)
            })
            .cloned()
    };
    if let Some(p) = root_named("index.md") {
        return Some(p);
    }
    if let Some(p) = root_named("README.md") {
        return Some(p);
    }
    if md_files.len() == 1 {
        return Some(md_files[0].clone());
    }
    None
}

fn zip_err(e: zip::result::ZipError) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, e.to_string())
}

/// Extract `mdx_path` into a fresh temp directory and locate the entry `.md`.
pub fn open_mdx(mdx_path: &Path) -> io::Result<MdxSession> {
    let temp = tempfile::Builder::new()
        .prefix("mdpreview-mdx-")
        .tempdir()?;
    let root = temp.path().to_path_buf();

    let file = fs::File::open(mdx_path)?;
    let mut archive = zip::ZipArchive::new(file).map_err(zip_err)?;

    let mut md_files: Vec<PathBuf> = Vec::new();
    for i in 0..archive.len() {
        let mut entry = archive.by_index(i).map_err(zip_err)?;
        // zip-slip guard: `enclosed_name()` yields a safe relative path
        // (no absolute paths, no `..`) or `None` for a malicious entry.
        let rel: PathBuf = match entry.enclosed_name() {
            Some(p) => p.to_owned(),
            None => continue,
        };
        let out_path = root.join(&rel);
        if entry.is_dir() {
            fs::create_dir_all(&out_path)?;
            continue;
        }
        if let Some(parent) = out_path.parent() {
            fs::create_dir_all(parent)?;
        }
        let mut out = fs::File::create(&out_path)?;
        io::copy(&mut entry, &mut out)?;
        if is_md(&rel) {
            md_files.push(rel);
        }
    }

    let entry_rel = pick_entry(&md_files).ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::NotFound,
            "no entry markdown (index.md / README.md / single .md) found in .mdx",
        )
    })?;
    let entry = root.join(entry_rel);

    Ok(MdxSession {
        mdx_path: mdx_path.to_path_buf(),
        temp,
        entry,
    })
}

fn collect_files(dir: &Path, out: &mut Vec<PathBuf>) -> io::Result<()> {
    for entry in fs::read_dir(dir)? {
        let entry = entry?;
        let p = entry.path();
        if p.is_dir() {
            collect_files(&p, out)?;
        } else if p.is_file() {
            out.push(p);
        }
    }
    Ok(())
}

/// Build a forward-slash ZIP entry name from a relative path (drops any
/// non-`Normal` components defensively).
fn rel_to_zip_name(rel: &Path) -> String {
    rel.components()
        .filter_map(|c| match c {
            Component::Normal(s) => s.to_str(),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("/")
}

/// Repack the contents of `temp_dir` back into `mdx_path`. Writes to a sibling
/// `*.mdx.tmp` first, then atomically renames over the original.
pub fn repack_mdx(temp_dir: &Path, mdx_path: &Path) -> io::Result<()> {
    let tmp_out = mdx_path.with_extension("mdx.tmp");
    {
        let file = fs::File::create(&tmp_out)?;
        let mut zip = zip::ZipWriter::new(file);
        let options = zip::write::SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Deflated);

        let mut entries: Vec<PathBuf> = Vec::new();
        collect_files(temp_dir, &mut entries)?;
        for abs in &entries {
            let rel = abs.strip_prefix(temp_dir).unwrap_or(abs);
            let name = rel_to_zip_name(rel);
            if name.is_empty() {
                continue;
            }
            zip.start_file(name, options).map_err(zip_err)?;
            let data = fs::read(abs)?;
            zip.write_all(&data)?;
        }
        zip.finish().map_err(zip_err)?;
    }
    fs::rename(&tmp_out, mdx_path)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ext_detection() {
        assert!(is_mdx_ext(Path::new("a/b/foo.mdx")));
        assert!(is_mdx_ext(Path::new("FOO.MDX")));
        assert!(!is_mdx_ext(Path::new("foo.md")));
        assert!(!is_mdx_ext(Path::new("foo")));
    }

    #[test]
    fn pick_entry_prefers_index_then_readme_then_single() {
        let idx = PathBuf::from("index.md");
        let readme = PathBuf::from("README.md");
        let other = PathBuf::from("notes.md");
        assert_eq!(pick_entry(&[other.clone(), idx.clone(), readme.clone()]), Some(idx));
        assert_eq!(pick_entry(&[other.clone(), readme.clone()]), Some(readme));
        assert_eq!(pick_entry(&[other.clone()]), Some(other));
        // Multiple, none named -> ambiguous -> None.
        assert_eq!(pick_entry(&[PathBuf::from("a.md"), PathBuf::from("b.md")]), None);
        // A nested index.md is NOT root-level, so the single-file rule applies.
        let nested = PathBuf::from("sub/index.md");
        assert_eq!(pick_entry(&[nested.clone()]), Some(nested));
    }

    #[test]
    fn repack_then_open_roundtrip() {
        // Stage a bundle in a temp dir.
        let stage = tempfile::tempdir().unwrap();
        fs::create_dir_all(stage.path().join("img")).unwrap();
        fs::write(stage.path().join("index.md"), b"# Hello\n![x](img/a.txt)\n").unwrap();
        fs::write(stage.path().join("img/a.txt"), b"resource-bytes").unwrap();

        // Pack into an .mdx alongside the stage dir's parent.
        let mdx_path = stage.path().parent().unwrap().join("roundtrip-test.mdx");
        repack_mdx(stage.path(), &mdx_path).unwrap();
        assert!(mdx_path.exists());

        // Re-open and verify entry + resource extracted correctly.
        let sess = open_mdx(&mdx_path).unwrap();
        assert_eq!(sess.entry.file_name().unwrap(), "index.md");
        let entry_body = fs::read_to_string(&sess.entry).unwrap();
        assert!(entry_body.starts_with("# Hello"));
        let res = fs::read_to_string(sess.temp.path().join("img/a.txt")).unwrap();
        assert_eq!(res, "resource-bytes");

        // Edit the entry and repack; reopening must reflect the change.
        fs::write(&sess.entry, b"# Edited\n").unwrap();
        repack_mdx(sess.temp.path(), &mdx_path).unwrap();
        let sess2 = open_mdx(&mdx_path).unwrap();
        assert_eq!(fs::read_to_string(&sess2.entry).unwrap(), "# Edited\n");
        // Resource survives the repack too.
        assert!(sess2.temp.path().join("img/a.txt").exists());

        let _ = fs::remove_file(&mdx_path);
    }

    #[test]
    fn opens_committed_sample_bundle() {
        // The sample is produced by PowerShell's Compress-Archive (a different
        // ZIP producer than our writer) — verify our reader handles it.
        let sample = Path::new(env!("CARGO_MANIFEST_DIR")).join("samples/bundle.mdx");
        if !sample.exists() {
            return; // sample optional in minimal checkouts
        }
        let sess = open_mdx(&sample).unwrap();
        assert_eq!(sess.entry.file_name().unwrap(), "index.md");
        assert!(sess.temp.path().join("images/test.png").exists());
        assert!(sess.temp.path().join("data/sales.csv").exists());
    }
}
