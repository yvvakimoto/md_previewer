# Generates assets/marp/{indigo,purple,green,gold,silver,black,dark}.css from the
# table of designed hex colours below. Each token becomes a relative colour of
# --theme-color:  oklch(from var(--theme-color) L calc(c * K) calc(h + dH))
# with L / K / dH solved from the designed hex (see the header of magenta.css,
# which is hand-written and is the template these files follow).
#
# Run from the repo root:  python tools/marp-theme-gen/gen_themes.py
# Re-run after editing a colour in T; magenta.css itself is not generated, but
# its `section.invert` block must equal what this prints for the magenta dark
# set (the script prints that block last so the two can be compared).
import io, math, os

def lin(c):
    c /= 255
    return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4

def oklch(hx):
    hx = hx.lstrip('#')
    r, g, b = [lin(int(hx[i:i + 2], 16)) for i in (0, 2, 4)]
    l = 0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b
    m = 0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b
    s = 0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b
    l_, m_, s_ = l ** (1 / 3), m ** (1 / 3), s ** (1 / 3)
    L = 0.2104542553 * l_ + 0.7936177850 * m_ - 0.0040720468 * s_
    a = 1.9779984951 * l_ - 2.4285922050 * m_ + 0.4505937099 * s_
    bb = 0.0259040371 * l_ + 0.7827717662 * m_ - 0.8086757660 * s_
    return L, math.hypot(a, bb), math.degrees(math.atan2(bb, a)) % 360

def derive(hx, base, cap=None, absolute=False):
    """CSS for `hx` as a relative colour of --theme-color whose designed value is `base`."""
    L, C, H = oklch(hx)
    Lb, Cb, Hb = oklch(base)
    if absolute or Cb < 1e-4:
        return 'oklch(%.4f %.4f %.1f)' % (L, C, H) if C > 1e-4 else 'oklch(%.4f 0 0)' % L
    K = C / Cb
    dH = ((H - Hb + 180) % 360) - 180
    cexpr = 'c' if abs(K - 1) < 1e-4 else 'calc(c * %.4f)' % K
    if cap is not None:
        cexpr = 'calc(min(c, %.4f) * %.4f)' % (cap, K)
    if abs(dH) < 0.05:
        hexpr = 'h'
    else:
        hexpr = 'calc(h %s %.1f)' % ('-' if dH < 0 else '+', abs(dH))
    return 'oklch(from var(--theme-color) %.4f %s %s)' % (L, cexpr, hexpr)

def tinted(hx, base, cap=None):
    """Rule-family token for a grey base (black): the picked hue tints it, capped."""
    L, C, H = oklch(hx)
    return 'oklch(from var(--theme-color) %.4f min(c, %.4f) h)' % (L, cap)

LIGHT_NEUTRAL = dict(bg='#fdfcfb', surface='#ffffff', surface_alt='#f6f8fa',
                     ink='#1a1a1a', ink2='#4a4a4a', ink3='#7a7a7a', code_bg='#f6f8fa', code_ink='#24292e')
DARK_NEUTRAL = dict(bg='#15151b', surface='#1f1f27', surface_alt='#24242d',
                    ink='#ececf1', ink2='#c3c3cb', ink3='#8e8e98', code_bg='#161b22', code_ink='#c9d1d9')

# name: (jp title, description, light set, dark set, light-neutral overrides, laser dH (deg) or abs, marker spec)
T = {
 'magenta': dict(
    light=dict(accent='#c2185b', soft='#fce4ec', deep='#880e4f', rule='#00838f', rulesoft='#b2ebf2'),
    dark =dict(accent='#f06292', soft='#3a1e2b', deep='#f8bbd0', rule='#4dd0e1', rulesoft='#163338'),
    laser_dh=-155, marker_light='#f48fb1'),
 'indigo': dict(
    title='Indigo — 藍 × 朱', desc='deep indigo accent, vermilion rule',
    light=dict(accent='#303f9f', soft='#e8eaf6', deep='#1a237e', rule='#bf360c', rulesoft='#fde3d8'),
    dark =dict(accent='#7986cb', soft='#232840', deep='#c5cae9', rule='#ffab91', rulesoft='#3a2620'),
    bg='#fbfbfd', laser_dh=124, marker_light='#9fa8da'),
 'purple': dict(
    title='Purple — 紫 × ティール', desc='royal purple accent, teal rule',
    light=dict(accent='#7b1fa2', soft='#f3e5f5', deep='#4a148c', rule='#00796b', rulesoft='#b2dfdb'),
    dark =dict(accent='#ba68c8', soft='#2f2236', deep='#e1bee7', rule='#4db6ac', rulesoft='#163330'),
    bg='#fcfbfd', laser_dh=-132, marker_light='#ce93d8'),
 'green': dict(
    title='Green — 緑 × ブルーグレー', desc='forest green accent, slate rule',
    light=dict(accent='#2e7d32', soft='#e8f5e9', deep='#1b5e20', rule='#455a64', rulesoft='#cfd8dc'),
    dark =dict(accent='#81c784', soft='#1f2f21', deep='#c8e6c9', rule='#90a4ae', rulesoft='#262e33'),
    bg='#fbfdfb', laser_dh=-110, marker_light='#a5d6a7'),
 'gold': dict(
    title='Gold — 金 × ネイビー', desc='old-gold accent, navy rule',
    light=dict(accent='#a67c00', soft='#fdf3d6', deep='#6b4f00', rule='#1f3a5f', rulesoft='#dbe4ee'),
    dark =dict(accent='#e6c15a', soft='#332b16', deep='#f5e3a6', rule='#90b4dd', rulesoft='#1d2a3a'),
    bg='#fdfcf8', laser_dh=172, marker_light='#ffe082'),
 'silver': dict(
    title='Silver — 銀 × スチールブルー', desc='cool grey accent, steel-blue rule; chroma is capped so the picker only tints',
    light=dict(accent='#6b7b8c', soft='#eef1f4', deep='#2f3a45', rule='#3f6a8a', rulesoft='#dce6ee'),
    dark =dict(accent='#a3b1bf', soft='#262b31', deep='#e2e8ee', rule='#7fa7c9', rulesoft='#1d2933'),
    bg='#fbfbfc', cap=0.0324, laser_dh=150, marker_light='oklch(from var(--theme-color) 0.85 0.06 h)',
    marker_dark='oklch(from var(--theme-color) 0.5 0.06 h)'),
 'black': dict(
    title='Black — 墨', desc='monochrome ink; only the rule family, laser and marker take the picked hue as a 差し色',
    light=dict(accent='#212121', soft='#eeeeee', deep='#000000', rule='#616161', rulesoft='#e0e0e0'),
    dark =dict(accent='#e0e0e0', soft='#2a2a2a', deep='#ffffff', rule='#9e9e9e', rulesoft='#262626'),
    bg='#ffffff', ink='#111111', ink2='#444444', ink3='#777777', mono=True, laser_dh=25,
    marker_light='#ffeb3b', marker_dark='#8d6e00'),
}

def token_block(name, spec, which, indent='  '):
    """Return the CSS lines for one token set (light or dark)."""
    t = T[name]
    base = t['light']['accent']
    cap = t.get('cap')
    mono = t.get('mono', False)
    S = spec
    out = []
    def line(var, expr, hx):
        out.append('%s%-14s %s;%s/* %s */' % (indent, var + ':', expr, ' ' * max(1, 62 - len(var) - len(expr)), hx))
    def tok(hx):
        if mono:
            return derive(hx, base, absolute=True)
        return derive(hx, base, cap=cap)
    def rtok(hx, capc):
        if mono:
            return tinted(hx, base, cap=capc)
        return derive(hx, base, cap=cap)
    line('--accent', tok(S['accent']), S['accent'])
    line('--accent-soft', tok(S['soft']), S['soft'])
    line('--accent-deep', tok(S['deep']), S['deep'])
    line('--rule', rtok(S['rule'], 0.08), S['rule'])
    line('--rule-soft', rtok(S['rulesoft'], 0.03), S['rulesoft'])
    return out

def divider_block(name, indent='  '):
    t = T[name]; S = t['light']; base = S['accent']
    cap = t.get('cap'); mono = t.get('mono', False)
    a = derive(S['deep'], base, absolute=mono, cap=cap)
    b = derive(S['accent'], base, absolute=mono, cap=cap)
    c = tinted(S['rule'], base, 0.08) if mono else derive(S['rule'], base, cap=cap)
    return [
        '%s--divider-a:   %s;   /* = accent-deep */' % (indent, a),
        '%s--divider-b:   %s;   /* = accent */' % (indent, b),
        '%s--divider-c:   %s;   /* = rule */' % (indent, c),
        '%s--divider-bg:  linear-gradient(135deg in srgb, var(--divider-a) 0%%, var(--divider-b) 60%%, var(--divider-c) 100%%);' % indent,
    ]

def neutrals(n, indent='  '):
    return [
        '%s--bg:          %s;' % (indent, n['bg']),
        '%s--surface:     %s;' % (indent, n['surface']),
        '%s--surface-alt: %s;' % (indent, n['surface_alt']),
        '%s--ink:         %s;' % (indent, n['ink']),
        '%s--ink-2:       %s;' % (indent, n['ink2']),
        '%s--ink-3:       %s;' % (indent, n['ink3']),
        '%s--code-bg:     %s;' % (indent, n['code_bg']),
        '%s--code-ink:    %s;' % (indent, n['code_ink']),
    ]

def laser(name, indent='  '):
    t = T[name]
    return '%s--laser-color: oklch(from var(--theme-color) 0.73 0.13 calc(h %s %d));' % (
        indent, '-' if t['laser_dh'] < 0 else '+', abs(t['laser_dh']))

def marker(name, which, indent='  '):
    t = T[name]
    if which == 'light':
        m = t['marker_light']
        expr = m if m.startswith('oklch') else derive(m, t['light']['accent'], cap=t.get('cap'), absolute=t.get('mono', False))
        return '%s--marker-color: %s;%s' % (indent, expr, '' if m.startswith('oklch') else '   /* %s */' % m)
    m = t.get('marker_dark')
    if m is None:
        return '%s--marker-color: oklch(from var(--theme-color) 0.55 calc(c * 0.9) h);   /* band behind light text */' % indent
    expr = m if m.startswith('oklch') else derive(m, t['light']['accent'], absolute=True)
    return '%s--marker-color: %s;' % (indent, expr)

def light_neutrals(name):
    n = dict(LIGHT_NEUTRAL)
    t = T[name]
    for k in ('bg', 'ink', 'ink2', 'ink3'):
        if k in t:
            n[k] = t[k]
    return n

def variant(name):
    t = T[name]
    L = []
    L.append('/* @theme %s */' % name)
    L.append('/* =================================================================')
    L.append('   %s' % t['title'])
    L.append('   A colour variation of magenta.css (%s).' % t['desc'])
    L.append('   Everything but the token values comes from the base — see the header')
    L.append('   of magenta.css for the colour model (one --theme-color input, tokens')
    L.append('   derived with fixed lightness) and for why `section.invert` must also')
    L.append('   set color-scheme and must not touch --divider-*.')
    L.append('')
    L.append('   Usage:  theme: %s   (front-matter; or pick it with the S key)' % name)
    L.append('   ================================================================= */')
    L.append('')
    L.append('@import "magenta";')
    L.append('')
    L.append(':root {')
    L.append('  --theme-color: %s;' % t['light']['accent'])
    L += token_block(name, t['light'], 'light')
    L += divider_block(name)
    L += neutrals(light_neutrals(name))
    L.append(laser(name))
    L.append(marker(name, 'light'))
    L.append('  --confidential-color: color-mix(in srgb, var(--accent) 13%, transparent);')
    L.append('  color-scheme: light;')
    L.append('}')
    L.append('')
    L.append('/* <!-- _class: invert --> : dark set for this hue (--divider-* untouched) */')
    L.append('section.invert {')
    L += token_block(name, t['dark'], 'dark')
    L += neutrals(DARK_NEUTRAL)
    L.append(marker(name, 'dark'))
    L.append('  --confidential-color: color-mix(in srgb, var(--accent) 16%, transparent);')
    L.append('  color-scheme: dark;')
    L.append('}')
    L.append('')
    L.append('/* ⚙ in the S-key picker. Parsed as JSON in its entirety — no prose inside. */')
    L.append('/* @user-vars')
    L.append('[')
    L.append('  { "var": "--theme-color", "type": "color", "default": "%s",' % t['light']['accent'])
    L.append('    "label": "テーマ色", "labelJa": "テーマ色（色相と鮮やかさが全体に反映）", "labelEn": "Theme color (hue & chroma drive the palette)" }')
    L.append(']')
    L.append('*/')
    L.append('')
    return '\n'.join(L)

def dark_theme():
    t = T['magenta']
    L = []
    L.append('/* @theme dark */')
    L.append('/* =================================================================')
    L.append('   Dark — 暗色背景 × マゼンタ')
    L.append('   magenta.css with its dark token set promoted to the whole deck: the')
    L.append('   values below are the SAME as magenta.css `section.invert` (keep the two')
    L.append('   in sync), and `section.invert` here swaps back to the light set so one')
    L.append('   slide can be bright. The section-divider gradient keeps the light')
    L.append('   magenta colours (white text needs the darker stops). See magenta.css')
    L.append('   for the colour model.')
    L.append('')
    L.append('   Usage:  theme: dark   (front-matter; or pick it with the S key)')
    L.append('   ================================================================= */')
    L.append('')
    L.append('@import "magenta";')
    L.append('')
    L.append(':root {')
    L.append('  --theme-color: %s;' % t['light']['accent'])
    L += token_block('magenta', t['dark'], 'dark')
    L += neutrals(DARK_NEUTRAL)
    L.append(marker('magenta', 'dark'))
    L.append('  --confidential-color: color-mix(in srgb, var(--accent) 16%, transparent);')
    L.append('  color-scheme: dark;')
    L.append('}')
    L.append('')
    L.append('/* <!-- _class: invert --> : back to the light magenta set */')
    L.append('section.invert {')
    L += token_block('magenta', t['light'], 'light')
    L += neutrals(LIGHT_NEUTRAL)
    L.append(marker('magenta', 'light'))
    L.append('  --confidential-color: color-mix(in srgb, var(--accent) 13%, transparent);')
    L.append('  color-scheme: light;')
    L.append('}')
    L.append('')
    L.append('/* ⚙ in the S-key picker. Parsed as JSON in its entirety — no prose inside. */')
    L.append('/* @user-vars')
    L.append('[')
    L.append('  { "var": "--theme-color", "type": "color", "default": "%s",' % t['light']['accent'])
    L.append('    "label": "テーマ色", "labelJa": "テーマ色（色相と鮮やかさが全体に反映）", "labelEn": "Theme color (hue & chroma drive the palette)" }')
    L.append(']')
    L.append('*/')
    L.append('')
    return '\n'.join(L)

os.makedirs('assets/marp', exist_ok=True)
for name in ('indigo', 'purple', 'green', 'gold', 'silver', 'black'):
    io.open('assets/marp/%s.css' % name, 'w', encoding='utf-8', newline='\n').write(variant(name))
io.open('assets/marp/dark.css', 'w', encoding='utf-8', newline='\n').write(dark_theme())
# Also print magenta's dark block so magenta.css's section.invert can be checked against it.
print('\n'.join(token_block('magenta', T['magenta']['dark'], 'dark')))
print('written')
