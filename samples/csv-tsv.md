# CSV / TSV Codeblocks

Fenced code blocks tagged `csv` or `tsv` render as HTML tables. The first row becomes the header.

## CSV (RFC 4180-ish)

Quoted fields preserve embedded commas and `""` escapes a literal quote.

```csv
Name,Role,Quote
Alice,Engineer,"Hello, world"
Bob,"Senior, Staff Engineer","He said ""ship it"""
Carol,Designer,Less is more
```

## TSV

Tab-separated. No quoting — every tab is a column boundary.

```tsv
Country	Capital	Population (M)
Japan	Tokyo	125
France	Paris	68
Brazil	Brasília	214
```

## Plain code block (regression check)

A fenced block with a non-data language still renders as syntax-highlighted code:

```python
def greet(name: str) -> str:
    return f"Hello, {name}"
```
