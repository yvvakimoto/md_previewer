# Syntax Highlighting

Code blocks are highlighted with highlight.js. Hover any block to reveal the **Copy** button in the top-right corner.

## JavaScript

```javascript
async function fetchUser(id) {
    const res = await fetch(`/api/users/${id}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
}
```

## Python

```python
from dataclasses import dataclass

@dataclass
class Point:
    x: float
    y: float

    def distance_to(self, other: "Point") -> float:
        return ((self.x - other.x) ** 2 + (self.y - other.y) ** 2) ** 0.5
```

## Rust

```rust
fn fibonacci(n: u32) -> u64 {
    match n {
        0 => 0,
        1 => 1,
        _ => fibonacci(n - 1) + fibonacci(n - 2),
    }
}
```

## Go

```go
package main

import "fmt"

func main() {
    sum := 0
    for i := 1; i <= 10; i++ {
        sum += i
    }
    fmt.Println("sum:", sum)
}
```

## SQL

```sql
SELECT u.name, COUNT(o.id) AS order_count
FROM users u
LEFT JOIN orders o ON o.user_id = u.id
WHERE u.created_at >= '2025-01-01'
GROUP BY u.name
ORDER BY order_count DESC
LIMIT 10;
```

## HTML + CSS

```html
<button class="btn btn--primary">Click me</button>
```

```css
.btn {
    padding: 0.5rem 1rem;
    border-radius: 4px;
    border: none;
    cursor: pointer;
}
.btn--primary {
    background: #3b82f6;
    color: #fff;
}
```

## Modelica

Not part of highlight.js core — registered by the in-house
`assets/libs/hljs-modelica.js`. Aliases: `mo`, `mos`.

```modelica
within MyLib.Examples;

model FirstOrder "A first-order system with a reset event"
  parameter Real T(unit = "s") = 0.5 "Time constant";
  parameter Real y0 = 1.0e-3 "Initial value";
  Real y(start = y0, fixed = true);
  Real 'quoted ident' = 2 "Q-IDENT is an identifier, not a string";
protected
  constant Real eps = 1e-12;
equation
  T * der(y) + y = if time < 1 then 0 else 1;
  when y > 0.9 then
    reinit(y, 0.9);
  end when;
algorithm
  for i in 1:3 loop
    if noEvent(abs(y) < eps) then
      break;
    end if;
  end for;
  annotation (Icon(coordinateSystem(preserveAspectRatio = false)));
end FirstOrder;

operator record Complex
  Real re;
  Real im;
end Complex;
```
