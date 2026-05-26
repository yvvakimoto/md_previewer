# Math Formula Test

## Inline Math

This is an inline formula: $E = mc^2$

The quadratic formula is: $x = \frac{-b \pm \sqrt{b^2 - 4ac}}{2a}$

Here's a simple sum: $\sum_{i=1}^{n} i = \frac{n(n+1)}{2}$

## Display Math

The Pythagorean theorem:

$$
a^2 + b^2 = c^2
$$

The quadratic formula in display mode:

$$
x = \frac{-b \pm \sqrt{b^2 - 4ac}}{2a}
$$

Euler's identity:

$$e^{i\pi} + 1 = 0$$

A more complex integral:

$$\int_{-\infty}^{\infty} e^{-x^2} dx = \sqrt{\pi}$$

Matrix example:

$$\begin{bmatrix}
a & b \\
c & d
\end{bmatrix}$$

Sum with limits:

$$\sum_{n=1}^{\infty} \frac{1}{n^2} = \frac{\pi^2}{6}$$

## Multiple lines

$$
\begin{pmatrix} \dot x_L^{(N)} \\ \dot \theta_L^{(N)} \end{pmatrix}
=
X_{RBM}^{(N)}
\begin{pmatrix} \delta_L \\ \epsilon_L \end{pmatrix} 
+ 
\begin{pmatrix} v_{DM}^{(N)} \\ \omega_{DM}^{(N)} \end{pmatrix}
$$

## Mixed Content

You can mix **bold text**, *italic text*, and math formulas like $\alpha + \beta = \gamma$ in the same paragraph.

Here's a list with math:
- First item: $f(x) = x^2$
- Second item: $g(x) = 2x + 1$
- Third item: $h(x) = \sin(x)$

## Complex Examples

The binomial theorem:

$$(x + y)^n = \sum_{k=0}^{n} \binom{n}{k} x^{n-k} y^k$$

The Fourier transform:

$$F(\omega) = \int_{-\infty}^{\infty} f(t) e^{-i\omega t} dt$$
## Math and Code Block

`$` a `$`,  `$E=mc^2$`

## `\left ... \right` 自動ペア（エディター機能）

エディター（`E` キー）で数式コンテキスト内に `\left` の直後に区切り文字を入力すると、対応する `\right<closer>` が自動挿入されます。

$$
\left( \frac{a}{b} \right)^2 + \left[ x + y \right] = \left\{ \alpha, \beta \right\}
$$

$$
\left\langle \psi \middle| \phi \right\rangle, \quad
\left| x \right|, \quad
\left\lfloor x \right\rfloor, \quad
\left\lceil x \right\rceil
$$

片側ヌル区切り (`\left.` / `\right.`)：

$$
\left. \frac{dy}{dx} \right|_{x=0}
$$
