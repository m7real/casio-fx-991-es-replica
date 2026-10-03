# fx-991ES PLUS — web replica

A dependency-free replica of the Casio fx-991ES PLUS scientific calculator: the same
47-key layout and SHIFT/ALPHA legends, the same calculation rules, and a natural
display (stacked fractions, superscripts, radicals, sexagesimal).

Pure HTML/CSS/JavaScript — no build step, no dependencies, no network calls.
Not affiliated with or endorsed by Casio.

## Running it

Open `index.html` in any modern browser, or serve the folder:

```
python -m http.server 8000
```

then visit `http://localhost:8000/calc/`.

## Files

| File | Contents |
| --- | --- |
| `index.html` | Shell: LCD, status indicators, menus, prompts, keypad/replay markup, CSS |
| `app.js` | The calculator itself: expression engine, display renderer, key handling, menus, solver, history |

`app.js` runs unchanged in Node (`module.exports`) and in the browser (`window.CALC`).

## What works

* Keypad with the physical legends, the REPLAY dial, ON/OFF, and the "any key clears the
  error" behaviour.
* Natural display: stacked fractions, superscripts, `√ ⁿ√ ∛ d/dx ∫dx`, `° ′ ″`.
* COMP-mode arithmetic with correct precedence, implicit multiplication (`2π`, `2(3+4)`,
  `3sin(4)`), fraction chains (`3/1/2 = 3.5`) and left-to-right `÷`.
* The manual's percent rules: `150×20% = 30`, `660÷880% = 75`, `2500+2500×15% = 2875`.
* Result cycling with `◀ ▶` between decimal, fraction, π, radical and DMS forms.
* `S⇔D` conversions, `SHIFT S⇔D` mixed ↔ improper fractions.
* Angle units (`DEG/RAD/GRA`, `DRG▶`), DMS input/output, ENG engineering display.
* Math: factorial and double factorial, nPr/nCr, `Pol`/`Rec`, `log`/`ln`, trigonometric,
  hyperbolic and inverse functions, `Abs`, `√`, `ⁿ√`, `∛`, `∫`, `d/dx`, `Σ`.
* `SOLVE` (numeric; prompts for the unknown, then the remaining variables), `STO`/`RCL`
  in `A`–`F`, `X`, `Y`, `M`, and `ANS`.
* History: REPLAY `▲ ▼` walks results, `◀ ▶` restores the expression for editing.
* `MODE` and `SETUP` menus (MthIO/LineIO, Deg/Rad/Gra, Fix/Sci/Norm, ab/c), `CONST`, `CLR`,
  `Rnd` / `Ran#` / `RanInt`.

## Keyboard

| Key | Action |
| --- | --- |
| `0`–`9`, `.` | digits |
| `+` `-` `*` `/` `^` | `+` `−` `×` fraction bar `xʸ` |
| `(` `)` `!` `%` | brackets, `x!`, percent |
| `Enter` / `Shift+Enter` | `EXE` / forced decimal |
| `Backspace` | `DEL` (removes a whole function template) |
| `Esc` | `AC` |
| `↑ ↓ ← →` | REPLAY: history and expression restore |
| `p e r i s c t l n h q d o a v` | `π`, `eˣ`, `√`, `ⁿ√`, `sin`, `cos`, `tan`, `log`, `ln`, `hyp`, `(−)`, `d/dx`, `∫dx`, `ALPHA`, `ENG` |
| `b`–`f`, `m`, `x`, `y` | variable keys |

## Driving the engine from Node

`app.js` has no DOM dependency, so the calculator can be scripted:

```js
const CALC = require('./app.js');

CALC.evaluateStatement('660÷880%');   // 75
CALC.evaluateStatement('1÷0');        // throws CalcError: Math ERROR
CALC.evaluateStatement('2+');         // throws CalcError: Syntax ERROR

CALC.reset();
['d1', 'd5', 'd0', 'mul', 'lparen', 'd2', 'd0', 'percent', 'rparen', 'exe']
  .forEach(k => CALC.pressKey(k));
CALC.state().ans;                     // 30
```

## Known limits

* `CMPLX`, `STAT`, `BASE-N`, `EQN` and `TABLE` appear in the `MODE` menu but are not
  implemented; `CONV` lists its categories without converting units.
* `∫`, `d/dx`, `Σ` and `SOLVE` are numeric (Simpson's rule, central difference, discrete
  steps, root finding) rather than symbolic.
* Factorials are exact up to `170!`.
