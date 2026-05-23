# Advanced

A `_toc.md` at the root controls file order and grouping. It is a normal
Markdown bullet list of links:

```markdown
- [Page title](path/to/file.md)
- Group label
    - [Nested page](sub/page.md)
```

Files present on disk but absent from `_toc.md` are appended under a
synthetic "Other" group, so nothing on disk is ever hidden.
