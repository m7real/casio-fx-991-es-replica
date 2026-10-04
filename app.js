/* ============================================================================
   CASIO fx-991ES PLUS — replica engine
   Natural-display calculator: key spec, state machine, expression pipeline,
   renderer, menus, CALC/SOLVE, history, ENG, DRG, STO/RCL.

   Works in the browser (auto-inits UI) and in Node (module.exports for tests).
   ========================================================================== */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.CALC = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  /* ====================================================================== *
   *  0. small utilities
   * ==================================================================== */
  function isDigit(c) { return c >= '0' && c <= '9'; }
  function isAlpha(c) { return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z'); }
  function isWordChar(c) { return isAlpha(c) || isDigit(c) || c === '_'; }

  function CalcError(msg) {
    this.name = 'CalcError';
    this.message = msg || 'Math ERROR';
  }
  CalcError.prototype = Object.create(Error.prototype);
  CalcError.prototype.constructor = CalcError;

  function syntax() { return new CalcError('Syntax ERROR'); }
  function mathErr() { return new CalcError('Math ERROR'); }

  /* index of the matching ')' for s[open]; -1 if unbalanced */
  function matchParen(s, open) {
    var d = 0;
    for (var i = open; i < s.length; i++) {
      if (s[i] === '(') d++;
      else if (s[i] === ')') { d--; if (d === 0) return i; }
    }
    return -1;
  }

  /* split on top-level chars in `seps` (depth 0 only) */
  function splitTop(s, seps) {
    var out = [], d = 0, start = 0;
    for (var i = 0; i < s.length; i++) {
      var c = s[i];
      if (c === '(') d++;
      else if (c === ')') d--;
      else if (d === 0 && seps.indexOf(c) >= 0) { out.push(s.slice(start, i)); start = i + 1; }
    }
    out.push(s.slice(start));
    return out;
  }

  /* Split keeping the separators (used to rebuild expressions losslessly). */
  function splitKeep(s, seps) {
    var out = [], d = 0, start = 0;
    for (var i = 0; i < s.length; i++) {
      var c = s[i];
      if (c === '(') d++;
      else if (c === ')') d--;
      else if (d === 0 && seps.indexOf(c) >= 0) {
        out.push(s.slice(start, i));
        out.push(c);
        start = i + 1;
      }
    }
    out.push(s.slice(start));
    return out;
  }

  /* start index of the operand that ends at exclusive index `end` */
  function operandStart(s, end) {
    if (end <= 0) return 0;
    var c = s[end - 1];
    if (c === ')') {
      var d = 0, j = end - 1;
      for (; j >= 0; j--) {
        if (s[j] === ')') d++;
        else if (s[j] === '(') { d--; if (d === 0) break; }
      }
      if (j < 0) return 0;
      j--;                                     // step before '('
      while (j >= 0 && isWordChar(s[j])) j--; // include function name / var
      return j + 1;
    }
    if (isDigit(c) || c === '.') {
      var k = end;
      while (k > 0 && (isDigit(s[k - 1]) || s[k - 1] === '.')) k--;
      return k;
    }
    if (isAlpha(c)) {
      var m = end;
      while (m > 0 && isWordChar(s[m - 1])) m--;
      return m;
    }
    if (c === 'π') return end - 1;
    if (c === '!') return operandStart(s, end - 1);
    return end - 1;                            // single symbol (√ ∛ ⁿ√ ∫ …)
  }

  /* numeric literal that is safe to embed in the JS source */
  function numLit(n) {
    if (typeof n !== 'number' || !isFinite(n)) throw mathErr();
    if (n === 0) return '0';
    var a = Math.abs(n);
    if (Number.isInteger(n) && a < 1e15) return String(n);
    var s = String(n);
    if (s.indexOf('e') >= 0) s = n.toFixed(20).replace(/0+$/, '').replace(/\.$/, '');
    return '(' + s + ')';
  }

  function esc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  /* ====================================================================== *
   *  1. numeric helpers
   * ==================================================================== */
  function factorial(n) {
    if (!Number.isInteger(n) || n < 0 || n > 170) return NaN;
    var r = 1;
    for (var i = 2; i <= n; i++) r *= i;
    return r;
  }

  /* continued fractions -> {n,d}; null when not a good rational fit */
  function toFraction(x, maxDen) {
    if (!isFinite(x)) return null;
    if (x === 0) return { n: 0, d: 1 };
    maxDen = maxDen || 99999;
    var sign = x < 0 ? -1 : 1;
    var v = Math.abs(x);
    if (Number.isInteger(v)) return { n: sign * v, d: 1 };
    var h1 = 1, h2 = 0, k1 = 0, k2 = 1, b = v, i;
    for (i = 0; i < 64; i++) {
      var a = Math.floor(b);
      var h = a * h1 + h2, k = a * k1 + k2;
      if (k > maxDen) break;
      h2 = h1; h1 = h; k2 = k1; k1 = k;
      var frac = b - a;
      if (frac < 1e-14) break;
      b = 1 / frac;
    }
    if (k1 <= 1) return null;
    if (Math.abs(v * k1 - h1) > 1e-11 * Math.max(1, v)) return null;
    return { n: sign * h1, d: k1 };
  }

  function gcd(a, b) { a = Math.abs(a); b = Math.abs(b); while (b) { var t = a % b; a = b; b = t; } return a; }

  function toDMS(v) {
    var sign = v < 0 ? '-' : '';
    var a = Math.abs(v);
    var d = Math.floor(a);
    var mRem = (a - d) * 60;
    var m = Math.floor(mRem + 1e-9);
    var sRem = round2((mRem - m) * 60);
    var sec = sRem;
    if (sec >= 60) { sec = 0; m += 1; }
    if (sec >= 59.5) { sec = 0; m += 1; }
    if (m >= 60) { m -= 60; d += 1; }
    return { sign: sign, d: d, m: m, s: sec, str: sign + d + '°' + m + "'" + sec + '"' };
  }
  function round2(x) {
    var r = Math.round(x * 100) / 100;
    return (Math.abs(r - Math.round(r)) < 1e-9) ? String(Math.round(r)) : String(r);
  }

  function drgConvert(value, from, to) {
    from = String(from || 'D').toUpperCase();
    to = String(to || 'D').toUpperCase();
    var r = value;
    if (from === 'D') r = value * Math.PI / 180;
    else if (from === 'G') r = value * Math.PI / 200;
    if (to === 'D') return r * 180 / Math.PI;
    if (to === 'G') return r * 200 / Math.PI;
    return r;
  }

  function toRad(x, angle) {
    if (angle === 'D') return x * Math.PI / 180;
    if (angle === 'G') return x * Math.PI / 200;
    return x;
  }
  function fromRad(x, angle) {
    if (angle === 'D') return x * 180 / Math.PI;
    if (angle === 'G') return x * 200 / Math.PI;
    return x;
  }

  /* ====================================================================== *
   *  2. helper functions bound into the sandbox
   * ==================================================================== */
  var HELPER_NAMES = ['SIN', 'COS', 'TAN', 'ASIN', 'ACOS', 'ATAN', 'SINH', 'COSH',
    'TANH', 'ASINH', 'ACOSH', 'ATANH', 'LOG', 'LN', 'SQRT', 'CBRT', 'FACT',
    'ABS', 'NPR', 'NCR', 'RAND', 'RANDINT', 'NTHROOT', 'SUM', 'POL', 'REC',
    'RND', 'ANS', 'PI', 'E'];

  var ALLOWED_IDENTS = ['SIN', 'COS', 'TAN', 'ASIN', 'ACOS', 'ATAN', 'SINH', 'COSH',
    'TANH', 'ASINH', 'ACOSH', 'ATANH', 'LOG', 'LN', 'SQRT', 'CBRT', 'FACT',
    'ABS', 'NPR', 'NCR', 'RAND', 'RANDINT', 'NTHROOT', 'SUM', 'POL', 'REC',
    'RND', 'ANS', 'PI', 'E'];

  /* user-typed function words that must not be treated as variables */
  var FUNC_WORDS = ['sin', 'cos', 'tan', 'asin', 'acos', 'atan', 'sinh', 'cosh',
    'tanh', 'asinh', 'acosh', 'atanh', 'log', 'ln', 'sqrt', 'cbrt', 'abs', 'Abs',
    'nPr', 'nCr', 'Pol', 'Rec', 'd',
    'sin⁻¹', 'cos⁻¹', 'tan⁻¹', 'sinh⁻¹', 'cosh⁻¹', 'tanh⁻¹'];

  var VAR_LETTERS = ['A', 'B', 'C', 'D', 'E', 'F', 'X', 'Y', 'M'];

  /* canonical spelling for user-typed function names (case-insensitive) */
  var FUNC_CANON = {
    'sin': 'sin', 'cos': 'cos', 'tan': 'tan',
    'asin': 'asin', 'acos': 'acos', 'atan': 'atan',
    'sinh': 'sinh', 'cosh': 'cosh', 'tanh': 'tanh',
    'asinh': 'asinh', 'acosh': 'acosh', 'atanh': 'atanh',
    'log': 'log', 'ln': 'ln', 'sqrt': 'sqrt', 'cbrt': 'cbrt',
    'abs': 'abs', 'npr': 'nPr', 'ncr': 'nCr', 'pol': 'Pol', 'rec': 'Rec'
  };

  function makeHelpers(angle, ctx) {
    var h = {};
    h.SIN = function (x) { return Math.sin(toRad(x, angle)); };
    h.COS = function (x) { return Math.cos(toRad(x, angle)); };
    h.TAN = function (x) { var c = Math.cos(toRad(x, angle)); if (Math.abs(c) < 1e-15) throw mathErr(); return Math.sin(toRad(x, angle)) / c; };
    h.ASIN = function (x) { return fromRad(Math.asin(x), angle); };
    h.ACOS = function (x) { return fromRad(Math.acos(x), angle); };
    h.ATAN = function (x) { return fromRad(Math.atan(x), angle); };
    h.SINH = function (x) { return Math.sinh(x); };
    h.COSH = function (x) { return Math.cosh(x); };
    h.TANH = function (x) { return Math.tanh(x); };
    h.ASINH = function (x) { return Math.asinh(x); };
    h.ACOSH = function (x) { return Math.acosh(x); };
    h.ATANH = function (x) { return Math.atanh(x); };
    h.LOG = function (a, b) {
      if (b === undefined) return Math.log(a) / Math.LN10;
      return Math.log(b) / Math.log(a);
    };
    h.LN = function (a) { return Math.log(a); };
    h.SQRT = function (a) { return Math.sqrt(a); };
    h.CBRT = function (a) { return Math.cbrt(a); };
    h.FACT = function (a) { return factorial(a); };
    h.ABS = Math.abs;
    h.NPR = function (n, r) {
      n = Math.round(n); r = Math.round(r);
      if (r < 0 || r > n || n < 0) return NaN;
      var res = 1;
      for (var i = 0; i < r; i++) res *= (n - i);
      return res;
    };
    h.NCR = function (n, r) {
      n = Math.round(n); r = Math.round(r);
      if (r < 0 || r > n || n < 0) return NaN;
      var res = 1;
      for (var i = 0; i < r; i++) res = res * (n - i) / (i + 1);
      return Math.round(res * 1e10) / 1e10;
    };
    h.RAND = function () { return Math.random(); };
    h.RANDINT = function (a, b) {
      a = Math.ceil(a); b = Math.floor(b);
      if (b < a) return NaN;
      return a + Math.floor(Math.random() * (b - a + 1));
    };
    h.NTHROOT = function (n, x) {
      if (x === 0) return 0;
      if (x < 0) {
        if (Math.abs(n % 2) < 1e-12) return NaN;
        return -Math.pow(-x, 1 / n);
      }
      return Math.pow(x, 1 / n);
    };
    h.POL = function (x, y) {
      var r = Math.sqrt(x * x + y * y);
      var th = fromRad(Math.atan2(y, x), angle);
      if (ctx) ctx.pol = { r: r, th: th };
      return r;
    };
    h.REC = function (r, th) {
      var t = toRad(th, angle);
      var x = r * Math.cos(t), y = r * Math.sin(t);
      if (ctx) ctx.rec = { x: x, y: y };
      return r;
    };
    h.RND = function (x) {
      var d = ctx && ctx.fix !== null && ctx.fix !== undefined ? ctx.fix : 10;
      var f = Math.pow(10, d);
      return Math.round(x * f) / f;
    };
    h.ANS = (ctx && typeof ctx.ans === 'number' && isFinite(ctx.ans)) ? ctx.ans : 0;
    h.SUM = function (expr, a, b) {
      return simpson(String(expr), a, b, ctx, ctx.depth || 0);
    };
    h.PI = Math.PI;
    h.E = Math.E;
    return h;
  }

  /* ====================================================================== *
   *  3. the expression pipeline
   *
   *  order: normalize -> split ':' -> [ DMS -> calculus -> percent ->
   *          factorial -> nth-root -> equation -> vars -> fractions ->
   *          implicit mult -> func map -> whitelist -> eval ]
   * ==================================================================== */
  function evaluate(raw, ctx) {
    ctx = ctx || {};
    var angle = ctx.angle || 'D';
    var vars = ctx.vars || {};
    var depth = ctx.depth || 0;

    var s = String(raw).trim();
    if (!s) throw syntax();

    /* --- split top-level statements on ':' (multi-statement input) --- */
    if (splitTop(s, ':').length > 1) {
      throw syntax();   /* caller (runStmt) handles statements, not evaluate */
    }

    s = tDMS(s);
    s = tCalculus(s, ctx, depth);
    s = tSum(s, ctx, depth);
    s = tPercent(s);
    s = tFactorial(s);
    s = tNthRoot(s);
    s = tSqrt(s);
    s = tEquation(s, ctx);
    s = tSugar(s);              /* ² -> ^2, ³ -> ^3 */
    s = tSci(s);                /* 2e3 -> 2000, 1.5E-3 -> (0.0015) */
    /* strip leading zeros so JS accepts casio-style 0236 */
    s = s.replace(/\d+(?:\.\d+)?/g, function (tok) {
      var dot = tok.indexOf('.');
      var intPart = dot >= 0 ? tok.slice(0, dot) : tok;
      var fracPart = dot >= 0 ? tok.slice(dot) : '';
      intPart = intPart.replace(/^0+(?=\d)/, '');
      if (intPart === '') intPart = '0';
      return intPart + fracPart;
    });
    s = tVars(s, vars, ctx);
    s = tFractions(s);
    s = tImplicitMult(s);
    s = tFuncs(s);

    /* --- unicode operators -> JS --- */
    s = s.replace(/÷/g, '/').replace(/×/g, '*').replace(/−/g, '-').replace(/·/g, '*');

    /* --- whitelist --- */
    if (!/^[0-9A-Za-z+\-*/^().,]*$/.test(s)) throw syntax();

    /* --- identifier allow-list --- */
    var idents = s.match(/[A-Za-z][A-Za-z0-9]*/g) || [];
    for (var i = 0; i < idents.length; i++) {
      if (ALLOWED_IDENTS.indexOf(idents[i]) < 0) throw syntax();
    }

    /* --- superscript ²/³ sugar is gone by now; ^ -> ** --- */
    var body = s.replace(/\^/g, '**');

    var helpers = makeHelpers(angle, ctx);
    var args = HELPER_NAMES.map(function (n) { return helpers[n]; });
    var fn;
    try {
      fn = new Function(HELPER_NAMES.join(','), '"use strict";return (' + body + ');');
    } catch (e) { throw syntax(); }
    var val;
    try { val = fn.apply(null, args); }
    catch (e) {
      if (e instanceof CalcError) throw e;
      throw mathErr();
    }
    if (typeof val !== 'number' || !isFinite(val)) throw mathErr();
    return val;
  }

  /* ---- DMS:  30°15'18"  ->  (30+15/60+18/3600) ---- */
  function tDMS(s) {
    var re = /(-?)(\d+(?:\.\d+)?)°\s*(?:(\d+(?:\.\d+)?)'\s*)?(?:(\d+(?:\.\d+)?)"\s*)?/g;
    return s.replace(re, function (m, sign, d, mi, sec) {
      var out = '(' + numLit(sign === '-' ? -parseFloat(d) : parseFloat(d));
      if (mi !== undefined) out += '+' + numLit(parseFloat(mi)) + '/60';
      if (sec !== undefined) out += '+' + numLit(parseFloat(sec)) + '/3600';
      return out + ')';
    });
  }

  /* ---- calculus: last ∫( / d/dx( first, so nesting works ---- */
  function tCalculus(s, ctx, depth) {
    if (depth > 3) throw syntax();
    var iInt = s.lastIndexOf('∫(');
    var iDdx = s.lastIndexOf('d/dx(');
    var i = Math.max(iInt, iDdx);
    if (i < 0) return s;
    var isInt = iInt >= iDdx;
    var open = i + (isInt ? 1 : 4);
    var close = matchParen(s, open);
    if (close < 0) throw syntax();
    var args = splitTop(s.slice(open + 1, close), ',');
    var num;
    if (isInt) {
      if (args.length < 3) throw syntax();
      var a = evaluate(args[1], ctx);
      var b = evaluate(args[2], ctx);
      num = simpson(args[0], a, b, ctx, depth);
    } else {
      if (args.length < 2) throw syntax();
      var x0 = evaluate(args[1], ctx);
      num = centralDiff(args[0], x0, ctx, depth);
    }
    var rep = '(' + numLit(num) + ')';
    return tCalculus(s.slice(0, i) + rep + s.slice(close + 1), ctx, depth + 1);
  }

  function withX(ctx, x) {
    var c = { angle: ctx.angle, vars: {}, ans: ctx.ans, fix: ctx.fix, sci: ctx.sci, norm: ctx.norm, depth: (ctx.depth || 0) + 1 };
    for (var k in (ctx.vars || {})) if (Object.prototype.hasOwnProperty.call(ctx.vars, k)) c.vars[k] = ctx.vars[k];
    c.vars.X = x;
    return c;
  }

  function simpson(fText, a, b, ctx, depth) {
    if (!isFinite(a) || !isFinite(b)) throw mathErr();
    if (a === b) return 0;
    var n = 200, h = (b - a) / n, sum = 0;
    for (var i = 0; i <= n; i++) {
      var x = a + i * h;
      var y = evaluate(fText, withX(ctx, x));
      sum += ((i === 0 || i === n) ? 1 : (i % 2 ? 4 : 2)) * y;
    }
    return sum * h / 3;
  }

  function centralDiff(fText, x0, ctx) {
    if (!isFinite(x0)) throw mathErr();
    var h = 1e-6 * Math.max(1, Math.abs(x0));
    var y1 = evaluate(fText, withX(ctx, x0 + h));
    var y0 = evaluate(fText, withX(ctx, x0 - h));
    var d = (y1 - y0) / (2 * h);
    if (!isFinite(d)) throw mathErr();
    return d;
  }

  /* ---- Σ(expr, bound, a, b)  ->  numeric value (bound var sampled as X) ---- */
  function tSum(s, ctx, depth) {
    var i = s.lastIndexOf('Σ(');
    if (i < 0) return s;
    var open = i + 1;
    var close = matchParen(s, open);
    if (close < 0) throw syntax();
    var args = splitTop(s.slice(open + 1, close), ',');
    if (args.length < 3) throw syntax();
    var bound = args[1].trim();
    if (!/^[A-Za-z]$/.test(bound)) throw syntax();
    var re = new RegExp('\\b' + bound + '\\b', 'g');
    var body = args[0].replace(re, 'X');
    var a = evaluate(args[2], ctx);
    var b = evaluate(args[3], ctx);
    if (!isFinite(a) || !isFinite(b)) throw mathErr();
    var step = a <= b ? 1 : -1, acc = 0, guard = 0;
    for (var k = a; step > 0 ? k <= b : k >= b; k += step) {
      acc += evaluate(body, withX(ctx, k));
      if (++guard > 100000) throw mathErr();
    }
    var num = acc;
    return tSum(s.slice(0, i) + '(' + numLit(num) + ')' + s.slice(close + 1), ctx, depth + 1);
  }

  /* ---- superscript sugar: ² -> ^2 , ³ -> ^3 ---- */
  function tSugar(s) {
    return s.replace(/²/g, '^2').replace(/³/g, '^3');
  }

  /* ---- percent:  a%  ->  ((a)/100) ----
     150×20% = 150×0.2 = 30 ;  660÷880% = 660÷8.8 = 75                    */
  function tPercent(s) {
    var i = s.indexOf('%');
    while (i >= 0) {
      var st = operandStart(s, i);
      var operand = s.slice(st, i);
      if (!operand.trim()) throw syntax();
      s = s.slice(0, st) + '((' + operand + ')/100)' + s.slice(i + 1);
      i = s.indexOf('%');
    }
    return s;
  }

  /* ---- factorial (right-to-left so n!! nests) ---- */
  function tFactorial(s) {
    var i = s.lastIndexOf('!');
    while (i >= 0) {
      if (i === 0) throw syntax();
      var st = operandStart(s, i);
      if (st >= i) throw syntax();
      var operand = s.slice(st, i);
      if (!operand.trim()) throw syntax();
      s = s.slice(0, st) + 'FACT(' + operand + ')' + s.slice(i + 1);
      i = s.lastIndexOf('!');
    }
    return s;
  }

  /* ---- nth root:  ⁿ√(b)  |  ⁿ√(a,b) ---- */
  function tNthRoot(s) {
    var i = s.indexOf('ⁿ√(');
    while (i >= 0) {
      var open = i + 2;
      var close = matchParen(s, open);
      if (close < 0) throw syntax();
var args = splitTop(s.slice(open + 1, close), ',');
      var rep;
      if (args.length >= 2) {
        rep = 'NTHROOT(' + args[0] + ',' + args[1] + ')';
        s = s.slice(0, i) + rep + s.slice(close + 1);
      } else {
        var st = operandStart(s, i);
        if (st >= i) throw syntax();
        rep = 'NTHROOT(' + s.slice(st, i) + ',' + args[0] + ')';
        s = s.slice(0, st) + rep + s.slice(close + 1);
      }
      i = s.indexOf('ⁿ√(');
    }
    return s;
  }

  /* ---- bare roots:  √2 , ∛27 , √(3+4) ---- */
  function tSqrt(s) {
    var guard = 0;
    while (guard++ < 40) {
      var iS = s.lastIndexOf('√'), iC = s.lastIndexOf('∛');
      var i = Math.max(iS, iC), name = (i === iS ? 'SQRT' : 'CBRT');
      if (i < 0) break;
      var next = s[i + 1] || '';
      if (next === '(') { s = s.slice(0, i) + name + s.slice(i + 1); continue; }
      if (!next) throw syntax();
      var j;
      if (next === 'π' || isAlpha(next)) j = i + 2;
      else if (isDigit(next) || next === '.') {
        j = i + 1;
        while (j < s.length && (isDigit(s[j]) || s[j] === '.')) j++;
      } else throw syntax();
      s = s.slice(0, i) + name + '(' + s.slice(i + 1, j) + ')' + s.slice(j);
    }
    return s;
  }

  /* ---- equation: single top-level '=', LHS single letter -> RHS ---- */
  function tEquation(s, ctx) {
    var idx = -1, d = 0;
    for (var i = 0; i < s.length; i++) {
      if (s[i] === '(') d++;
      else if (s[i] === ')') d--;
      else if (s[i] === '=' && d === 0) { if (idx >= 0) throw syntax(); idx = i; }
    }
    if (idx < 0) return s;
    var lhs = s.slice(0, idx).trim();
    var rhs = s.slice(idx + 1);
    if (!/^[A-Za-z]$/.test(lhs)) throw syntax();
    return rhs;   /* value of the equation = value of the RHS */
  }

  /* ---- variable substitution ---- */
  var SINGLE_VARS = 'ABCDEF';

  function lowerWord(w) { return w.length ? w.charAt(0).toUpperCase() + w.slice(1).toLowerCase() : w; }

  /* scientific notation: 2e3 / 2E3 / 1.5e-3 -> plain literal */
  function tSci(s) {
    return s.replace(/(\d+(?:\.\d+)?)[eE]([+-]?\d+)/g, function (m, a, b) {
      var n = Number(a + 'e' + b);
      return n.toFixed(18).replace(/0+$/, '').replace(/\.$/, '');
    });
  }

  function tVars(s, vars, ctx) {
    var out = '', i = 0, L = s.length;
    vars = vars || {};
    while (i < L) {
      var c = s[i];
      if (c === 'π') { out += 'PI'; i++; continue; }
      if (c === '°') { out += '*PI/180'; i++; continue; }
      if (isAlpha(c)) {
        var j = i;
        while (j < L && isAlpha(s[j])) j++;
        var word = s.slice(i, j);
        var upper = word.toUpperCase();
        /* generated / sandbox helper names pass straight through */
        if (ALLOWED_IDENTS.indexOf(upper) >= 0 && word === upper) { out += word; i = j; continue; }
        /* e-notation: digit already emitted, 'e' here means exponent */
        if (upper === 'E' && i > 0 && isDigit(s[i - 1])) {
          var k = j;
          if (s[k] === '+' || s[k] === '-') {
            if (k + 1 < L && isDigit(s[k + 1])) { out += 'E' + s[k]; i = k + 1; continue; }
          } else if (k < L && isDigit(s[k])) { out += 'E'; i = k; continue; }
        }
        if (upper === 'ANS') { out += 'ANS'; i = j; continue; }
        if (upper === 'RANINT') { out += 'RANDINT'; i = j; continue; }
        if (upper === 'RND') { out += 'RND(ANS)'; i = j; continue; }
        if (upper === 'RAN' && s[j] === '#') { out += 'RAND()'; i = j + 1; continue; }
        var canon = FUNC_CANON[String(word).toLowerCase()];
        if (canon) { out += canon; i = j; continue; }
        if (upper === 'E') { out += 'E'; i = j; continue; }
        /* single letters (any case) are variables A-F, X, Y, M */
        if (word.length === 1 && (SINGLE_VARS + 'XYM').indexOf(upper) >= 0) {
          var v = vars[upper];
          if (v === undefined) v = vars[word];
          out += '(' + numLit(v === undefined ? 0 : v) + ')';
          i = j;
          continue;
        }
        throw syntax();
      }
      out += c;
      i++;
    }
    return out;
  }

  /* ---- fractions: a b/c chains ----
   * split on top-level plus/minus (keeping ops), then each term on '*', '×', '÷', '/'.
   * `/` chain: 2 -> a/b ; 3 -> a+b/c (mixed) ; >3 -> Syntax ERROR.
   * division written with '÷' or '/' by the ÷ key is normalised to '/' earlier. */
  function tFractions(s) {
    var addParts = splitKeep(s, '+-−');
    var out = addParts.map(function (part) {
      if (part === '+' || part === '-' || part === '−') return part;
      return tFracTerm(part);
    });
    return out.join('');
  }

  function tFracTerm(term) {
    var toks = splitKeep(term, '*/×÷');
    /* toks alternate operand, op, operand, op, ... ; only '/' is the fraction bar,
       ÷ is the ordinary division key */
    var i = 0, out = '';
    while (i < toks.length) {
      if (i % 2 === 0) {
        /* operand - start a fraction chain if it is followed by '/' */
        var segs = [toks[i]];
        var n = i;
        while (n + 1 < toks.length && toks[n + 1] === '/') { segs.push(toks[n + 2]); n += 2; }
        out += segs.length > 1 ? buildFraction(segs) : segs[0];
        i = n + 1;
      } else {
        out += toks[i] === '÷' ? '/' : '*';
        i++;
      }
    }
    return out;
  }

  function buildFraction(segs) {
    if (segs.length === 1) return '(' + segs[0] + ')';
    if (segs.length === 2) return '(' + segs[0] + ')/(' + segs[1] + ')';
    if (segs.length === 3) {
      var whole = segs[0], num = segs[1], den = segs[2];
      if (!whole) return '(' + num + ')/(' + den + ')';
      if (!num) return '(' + whole + ')/(' + den + ')';
      return '(' + whole + '+(' + num + ')/(' + den + '))';
    }
    throw syntax();
  }

  /* ---- implicit multiplication: 2π  2(3+4)  3sin(4)  2A  (3)(4) ---- */
  function tImplicitMult(s) {
    var out = '', i = 0, L = s.length;
    function needMul(prev) {
      return isDigit(prev) || prev === ')' || prev === 'π' ||
        (isAlpha(prev) && s.indexOf(prev) >= 0 && true);
    }
    while (i < L) {
      var c = s[i];
      var prev = out.length ? out[out.length - 1] : '';
      /* a group followed by a value means multiplication: (2+3)4 */
      if (prev === ')' && (isDigit(c) || isAlpha(c) || c === 'π')) { out += '*'; prev = '*'; }
      /* an identifier or π run */
      if (isAlpha(c) || c === 'π') {
        var j = i, isPi = (c === 'π');
        if (isPi) j = i + 1;
        else while (j < L && isAlpha(s[j])) j++;
        var word = isPi ? 'π' : s.slice(i, j);
        /* keep PI separate from glued names: πe -> PI*E , eπ -> E*PI */
        var piAt = -1;
        if (!isPi && word !== 'PI') {
          for (var p = 0; p + 1 < word.length; p++) {
            if (word.substr(p, 2) === 'PI' &&
              (p === 0 || p + 2 === word.length)) { piAt = p; break; }
          }
        }
        var nextCh = s[j] || '';
        var isFunc = !isPi && FUNC_WORDS.indexOf(lowerWord(word)) >= 0;
        if (piAt >= 0) {
          var pre = word.slice(0, piAt), suf = word.slice(piAt + 2);
          var piece = 'PI';
          if (pre) piece = pre + '*' + piece;
          if (suf) piece = piece + '*' + suf;
          out += piece;
          i = j;
          continue;
        }
        if (prev && prev !== '(' && prev !== ',' && prev !== '*' && prev !== '/' &&
          prev !== '^' && prev !== '+' && prev !== '-' && prev !== '×' && prev !== '÷') {
          if (isDigit(prev) || prev === ')' || prev === 'π' ||
            (isAlpha(prev) && s.indexOf(prev) >= 0)) {
            out += '*';
          }
        }
        out += word;
        i = j;
        continue;
      }
      /* an opening paren directly after a value => multiplication */
      if (c === '(' && (isDigit(prev) || prev === ')' || prev === 'π')) out += '*';
      out += c;
      i++;
    }
    return out;
  }

  /* ---- function names -> sandbox helpers (longest first) ---- */
  var FUNC_MAP = [
    ['sinh⁻¹(', 'ASINH('], ['cosh⁻¹(', 'ACOSH('], ['tanh⁻¹(', 'ATANH('],
    ['sin⁻¹(', 'ASIN('], ['cos⁻¹(', 'ACOS('], ['tan⁻¹(', 'ATAN('],
    ['asinh(', 'ASINH('], ['acosh(', 'ACOSH('], ['atanh(', 'ATANH('],
    ['sinh(', 'SINH('], ['cosh(', 'COSH('], ['tanh(', 'TANH('],
    ['asin(', 'ASIN('], ['acos(', 'ACOS('], ['atan(', 'ATAN('],
    ['sin(', 'SIN('], ['cos(', 'COS('], ['tan(', 'TAN('],
    ['log(', 'LOG('], ['ln(', 'LN('],
    ['sqrt(', 'SQRT('], ['cbrt(', 'CBRT('],
    ['Abs(', 'ABS('], ['abs(', 'ABS('],
    ['nPr(', 'NPR('], ['nCr(', 'NCR('],
    ['Pol(', 'POL('], ['Rec(', 'REC('],
    ['RanInt(', 'RANDINT('], ['Rnd(', 'RND('],
    ['∛(', 'CBRT('], ['Σ(', 'SUM('], ['√(', 'SQRT(']
  ];

  function tFuncs(s) {
    for (var i = 0; i < FUNC_MAP.length; i++) {
      s = s.split(FUNC_MAP[i][0]).join(FUNC_MAP[i][1]);
    }
    /* 'Sin(' capitalised variants written by tests / power users */
    s = s.replace(/\bSin\(/g, 'SIN(').replace(/\bCos\(/g, 'COS(').replace(/\bTan\(/g, 'TAN(');
    s = s.replace(/\bLog\(/g, 'LOG(').replace(/\bLn\(/g, 'LN(').replace(/\bAbs\(/g, 'ABS(');
    return s;
  }

  /* ====================================================================== *
   *  4. result forms
   * ==================================================================== */
  function makeResult(expr, val, ctx) {
    ctx = ctx || {};
    var forms = [];

    /* dms form when the input was a pure DMS literal */
    var pureDMS = /^\(?-?\d+(?:\.\d+)?°\s*(?:\d+(?:\.\d+)?'\s*)?(?:\d+(?:\.\d+)?"\s*)?\)?$/.test(String(expr).trim());
    if (pureDMS && isFinite(val)) forms.push({ type: 'dms', v: val });

    /* fraction form for rational results */
    if (isFinite(val) && val !== 0 && Math.abs(val) < 1e10) {
      var f = toFraction(val);
      if (f) forms.push({ type: 'frac', n: f.n, d: f.d });
    }

    /* pi multiple */
    if (isFinite(val) && val !== 0 && String(expr).indexOf('π') >= 0) {
      var pf = toFraction(val / Math.PI);
      if (pf && Math.abs(pf.n) <= 999 && pf.d <= 999) {
        forms.push({ type: 'pi', n: pf.n, d: pf.d });
      }
    }

    /* simplified radical for ^√(n) style input */
    var rm = /^\^?√\((\d+)\)$/.exec(String(expr).trim()) ||
             /√\((\d+)\)/.exec(String(expr).trim());
    if (rm && isFinite(val)) {
      var rad = simplifyRadical(parseInt(rm[1], 10));
      if (rad) forms.push({ type: 'rad', k: rad.k, n: rad.n, d: rad.d });
    }

    forms.push({ type: 'dec' });
    return { expr: String(expr), val: val, forms: forms, idx: forms.length - 1, ctx: ctx };
  }

  /* extract k*√n form for n, e.g. 8 -> 2*√2 */
  function simplifyRadical(n) {
    if (n <= 0) return null;
    var k = 1, m = n, p = 2;
    while (p * p <= m) {
      while (m % (p * p) === 0) { m /= p * p; k *= p; }
      p++;
    }
    if (m === 1) return null;         /* perfect square -> plain integer */
    if (k === 1) return { k: 1, n: m, d: 1 };
    return { k: k, n: m, d: 1 };
  }

  function fmtDec(v, cfg) {
    cfg = cfg || {};
    var fix = cfg.fix, sci = cfg.sci, norm = cfg.norm || 1;
    /* snap near-integers */
    if (isFinite(v)) {
      var r = Math.round(v);
      if (Math.abs(v - r) < 1e-11 * Math.max(1, Math.abs(v))) v = r;
    }
    if (fix !== null && fix !== undefined) return v.toFixed(fix);
    if (sci !== null && sci !== undefined) {
      var ps = v.toPrecision(sci);
      return ps;
    }
    var av = Math.abs(v);
    if (v !== 0 && (av >= 1e10 || av < (norm === 2 ? 1e-2 : 1e-10))) {
      var ex = av.toExponential(norm === 2 ? 1 : 9);
      return trimZeros(ex);
    }
    return trimZeros(v.toPrecision(10));
  }

  function trimZeros(s) {
    if (/[eE]/.test(s)) {
      var p = s.split(/[eE]/);
      p[0] = p[0].replace(/\.?0+$/, '');
      return p[0] + 'e' + p[1];
    }
    if (s.indexOf('.') >= 0) s = s.replace(/0+$/, '').replace(/\.$/, '');
    return s;
  }

  function sciHTML(v, digits) {
    if (v === 0) return '0&times;10<sup>0</sup>';
    var ex = Math.floor(Math.log10(Math.abs(v)));
    var mant = v / Math.pow(10, ex);
    var ms = trimZeros(mant.toPrecision(digits || 10));
    return ms + '&times;10<sup>' + ex + '</sup>';
  }

  function resultHTML(result, cfg) {
    if (!result || !result.forms || !result.forms.length) return '';
    var form = result.forms[result.idx] || result.forms[0];
    var v = result.val;
    switch (form.type) {
      case 'dms': {
        var d = toDMS(form.v);
        if (d.m === 0 && d.s === 0) return d.sign + d.d + '&deg;';
        if (d.s === 0) return d.sign + d.d + '&deg;' + d.m + '&prime;';
        return d.sign + d.d + '&deg;' + d.m + '&prime;' + d.s + '&Prime;';
      }
      case 'frac': {
        var n = form.n, dd = form.d;
        if (cfg && cfg.mix === 'mixed' && dd > 1 && Math.abs(n) > dd) {
          var whole = Math.trunc(n / dd);
          var rn = n - whole * dd;
          return whole + ' <span class="frac"><span class="n">' + rn + '</span><span class="d">' + dd + '</span></span>';
        }
        return '<span class="frac"><span class="n">' + n + '</span><span class="d">' + dd + '</span></span>';
      }
      case 'pi': {
        var pn = form.n, pd = form.d;
        if (pd === 1 && pn === 1) return '&pi;';
        if (pd === 1 && pn === -1) return '&minus;&pi;';
        if (pd === 1) return pn + '&pi;';
        if (pd === 2 && pn === 1) return '&pi;/2';
        if (pd === 2 && pn === -1) return '&minus;&pi;/2';
        return '<span class="frac"><span class="n">' + pn + '&pi;</span><span class="d">' + pd + '</span></span>';
      }
      case 'rad': {
        if (form.n === form.d) return String(form.k);
        if (form.d === 1) {
          return (form.k === 1 ? '' : form.k + '&times;') + '&radic;' + form.n;
        }
        return (form.k === 1 ? '' : form.k + '&times;') +
          '<span class="frac"><span class="n">&radic;' + form.n + '</span><span class="d">' + form.d + '</span></span>';
      }
      case 'dec':
        return fmtDec(v, cfg);
      default:
        return fmtDec(v, cfg);
    }
  }

  /* ====================================================================== *
   *  5. natural-display renderer (expression line)
   * ==================================================================== */
  var DISP = {
    'sin': 'sin', 'cos': 'cos', 'tan': 'tan',
    'asin': 'sin<sup>&minus;1</sup>', 'acos': 'cos<sup>&minus;1</sup>', 'atan': 'tan<sup>&minus;1</sup>',
    'sinh': 'sinh', 'cosh': 'cosh', 'tanh': 'tanh',
    'asinh': 'sinh<sup>&minus;1</sup>', 'acosh': 'cosh<sup>&minus;1</sup>', 'atanh': 'tanh<sup>&minus;1</sup>',
    'log': 'log', 'ln': 'ln', 'sqrt': '√', 'Abs': 'Abs', 'abs': 'Abs',
    'nPr': 'nPr', 'nCr': 'nCr', 'Pol': 'Pol', 'Rec': 'Rec',
    'RanInt': 'RanInt', 'Rnd': 'Rnd', 'Ran#': 'Ran#',
    'Ans': 'Ans', 'e': 'e', '∫': '&int;', 'π': '&pi;',
    'sin⁻¹': 'sin<sup>&minus;1</sup>', 'cos⁻¹': 'cos<sup>&minus;1</sup>', 'tan⁻¹': 'tan<sup>&minus;1</sup>',
    'sinh⁻¹': 'sinh<sup>&minus;1</sup>', 'cosh⁻¹': 'cosh<sup>&minus;1</sup>', 'tanh⁻¹': 'tanh<sup>&minus;1</sup>'
  };

  function caret() { return '<span class="caret"></span>'; }

  /* render a full expression with a caret at index ci */
  function renderExpr(text, ci) {
    var s = String(text == null ? '' : text);
    if (ci == null) ci = s.length;
    return renderAdd(s, 0, s.length, ci);
  }

  /* tokens with absolute offsets: [{t, a, b}] */
  function tokSplit(str, a, b, seps) {
    var out = [], start = a, d = 0;
    for (var i = a; i < b; i++) {
      var c = str[i];
      if (c === '(') d++;
      else if (c === ')') d--;
      else if (d === 0 && seps.indexOf(c) >= 0) {
        if (i > start) out.push({ t: str.slice(start, i), a: start, b: i });
        out.push({ t: c, a: i, b: i + 1 });
        start = i + 1;
      }
    }
    if (b > start) out.push({ t: str.slice(start, b), a: start, b: b });
    return out;
  }

  function renderAdd(str, a, b, ci) {
    var toks = tokSplit(str, a, b, '+-−');
    var out = '';
    for (var i = 0; i < toks.length; i++) {
      var tk = toks[i];
      if (tk.t === '+') out += plus(tk.a, ci);
      else if (tk.t === '-' || tk.t === '−') out += minus(tk.a, ci);
      else out += renderMul(str, tk.a, tk.b, ci);
    }
    return out;
  }

  function plus(at, ci) { return (at === ci) ? caret() + '+' : '+'; }
  function minus(at, ci) { return (at === ci) ? caret() + '&minus;' : '&minus;'; }

  function renderMul(str, a, b, ci) {
    var toks = tokSplit(str, a, b, '×*÷/');
    var out = '';
    for (var i = 0; i < toks.length; i++) {
      var tk = toks[i];
      if (tk.t === '×' || tk.t === '*') out += (tk.a === ci ? caret() : '') + '&times;';
      else if (tk.t === '÷') out += (tk.a === ci ? caret() : '') + '&divide;';
      else if (tk.t === '/') {
        out += renderSeg(str, tk.a, tk.b, ci);
      }
      else if (i + 1 < toks.length && toks[i + 1].t === '/') {
        /* fraction chain:  a/b  or mixed  a/b/c  (one segment per slash + 1) */
        var segs = [tk], k = i;
        while (k + 1 < toks.length && toks[k + 1].t === '/' &&
          k + 2 < toks.length && isOperandTok(toks[k + 2])) {
          segs.push(toks[k + 2]);
          k += 2;
        }
        out += renderFracChain(str, segs, ci);
        i = k;
      }
      else out += renderSeg(str, tk.a, tk.b, ci);
    }
    return out;
  }

  function isOperandTok(t) {
    return !!t && t.t !== '×' && t.t !== '*' && t.t !== '÷' && t.t !== '/';
  }

  function renderFracChain(str, segs, ci) {
    /* 2 segments -> num/den ; 3 -> whole + num/den */
    if (segs.length === 2) {
      return fracHTML(renderSeg(str, segs[0].a, segs[0].b, ci),
        renderSeg(str, segs[1].a, segs[1].b, ci));
    }
    if (segs.length === 3) {
      return renderSeg(str, segs[0].a, segs[0].b, ci) +
        fracHTML(renderSeg(str, segs[1].a, segs[1].b, ci),
          renderSeg(str, segs[2].a, segs[2].b, ci));
    }
    return esc(segs.map(function (x) { return x.t; }).join('/'));
  }

  function fracHTML(num, den) {
    return '<span class="frac"><span class="n">' + num + '</span><span class="d">' + den + '</span></span>';
  }

  /* render a single multiplicative/additive segment (no top-level + - * /) */
  function renderSeg(str, a, b, ci) {
    var out = '', i = a;
    while (i < b) {
      if (i === ci) out += caret();
      var c = str[i];

      /* radical: √( ∛( ⁿ√( with optional index before */
      if (c === '√' || c === '∛' || c === 'ⁿ√') {
        var rOpen = i + (c === 'ⁿ√' ? 2 : 1);
        if (str[rOpen] === '(') {
          var rClose = matchParen(str, rOpen);
          if (rClose > 0 && rClose < b) {
            var inner = renderAdd(str, rOpen + 1, rClose, ci);
            var sup = '';
            if (c === 'ⁿ√') {
              var pre = str.slice(a, i);
              var m = /(\d+(?:\.\d+)?)$/.exec(pre);
              sup = '<span class="ix">' + (m ? m[1] : 'n') + '</span>';
            }
            out += '<span class="root">' + sup + '<span class="rad">' + (c === '∛' ? '∛' : '√') + '</span><span class="ovl">' + inner + '</span></span>';
            i = rClose + 1;
            continue;
          }
        }
      }

      /* identifier / function name */
      if (isAlpha(c)) {
        var j = i;
        while (j < b && isAlpha(str[j])) j++;
        var word = str.slice(i, j);
        /* the inverse forms use the ⁻¹ char inside the word */
        out += DISP[word] || esc(word);
        i = j;
        /* next '(' is rendered by the generic paren path */
        continue;
      }

      /* π */
      if (c === 'π') { out += '&pi;'; i++; continue; }

      /* exponent */
      if (c === '^') {
        var k = i + 1;
        if (str[k] === '(') {
          var ce = matchParen(str, k);
          if (ce > 0 && ce < b) {
            out += '<sup>' + renderAdd(str, k + 1, ce, ci) + '</sup>';
            i = ce + 1;
            continue;
          }
        } else if (k < b && (isDigit(str[k]) || ((str[k] === '-' || str[k] === '−') && isDigit(str[k + 1])))) {
          var re = /^[-−]?\d+(?:\.\d+)?/;
          var mm = re.exec(str.slice(k, b));
          out += '<sup>' + esc(mm[0].replace('−', '&minus;')) + '</sup>';
          i = k + mm[0].length;
          continue;
        }
        out += '^';
        i++;
        continue;
      }

      /* paren group */
      if (c === '(') {
        var cp = matchParen(str, i);
        if (cp > 0 && cp < b) {
          /* if a function name directly precedes, keep it; already emitted */
          out += '(' + renderAdd(str, i + 1, cp, ci) + ')';
          i = cp + 1;
          continue;
        }
      }

      /* superscript digits / inverse superscripts */
      if (c === '²') { out += '<sup>2</sup>'; i++; continue; }
      if (c === '³') { out += '<sup>3</sup>'; i++; continue; }
      if (c === '⁻¹') { out += '<sup>&minus;1</sup>'; i += 2; continue; }

      /* DMS marks */
      if (c === '°') { out += '&deg;'; i++; continue; }      if (c === "'") { out += '&prime;'; i++; continue; }
      if (c === '"') { out += '&Prime;'; i++; continue; }
      if (c === '!') { out += '!'; i++; continue; }
      if (c === '÷') { out += '&divide;'; i++; continue; }
      if (c === '×' || c === '*') { out += '&times;'; i++; continue; }
      if (c === '−') { out += '&minus;'; i++; continue; }
      if (c === '-') { out += '&minus;'; i++; continue; }
      if (c === ':') { out += ':'; i++; continue; }
      if (c === '=') { out += '='; i++; continue; }
      if (c === '%') { out += '%'; i++; continue; }
      if (c === ',') { out += ','; i++; continue; }
      if (c === '.') { out += '.'; i++; continue; }
      if (c === '\u0001' || c === '\u0002') { out += c; i++; continue; }

      out += esc(c);
      i++;
    }
    if (b === ci) out += caret();
    return out;
  }

  /* ====================================================================== *
   *  6. Newton solver
   * ==================================================================== */
  function solveX(fn, guess) {
    var x = guess;
    for (var i = 0; i < 100; i++) {
      var fx;
      try { fx = fn(x); } catch (e) { return null; }
      if (!isFinite(fx)) return null;
      if (Math.abs(fx) < 1e-12) return x;
      var h = 1e-7 * Math.max(1, Math.abs(x));
      var d;
      try { d = (fn(x + h) - fn(x - h)) / (2 * h); } catch (e) { return null; }
      if (!isFinite(d) || d === 0) return null;
      var nx = x - fx / d;
      if (!isFinite(nx)) return null;
      if (Math.abs(nx - x) < 1e-14 * Math.max(1, Math.abs(x))) { x = nx; break; }
      x = nx;
    }
    try { if (Math.abs(fn(x)) < 1e-9) return x; } catch (e) { return null; }
    return null;
  }

  function solveWithFallback(fn, guess) {
    var r = solveX(fn, guess);
    if (r !== null) return r;
    var seeds = [1, -1, 2, -2, 0.5, -0.5, 3, -3, 10, -10];
    for (var i = 0; i < seeds.length; i++) {
      if (seeds[i] === guess) continue;
      r = solveX(fn, seeds[i]);
      if (r !== null) return r;
    }
    return null;
  }

  /* ====================================================================== *
   *  7. key specifications (verified against the manual)
   * ==================================================================== */
  var PAD1 = [
    { id: 'replay', replay: true },
    { id: 'shift', main: 'SHIFT', type: 'blue' },
    { id: 'alpha', main: 'ALPHA', type: 'blue' },
    { id: 'mode', main: 'MODE', shift: 'SETUP', type: 'blue' },
    { id: 'on', main: 'ON', type: 'blue' },

    { id: 'calc', main: 'CALC', shift: 'SOLVE', alpha: '=' },
    { id: 'integral', main: '∫dx', shift: 'd/dx', alpha: ':' },
    { id: 'inv', main: 'x⁻¹', shift: 'x!' },
    { id: 'logab', main: 'logₐb', shift: 'Σ' },

    { id: 'frac', main: 'a b/c' },
    { id: 'sqrt', main: '√', shift: '∛' },
    { id: 'square', main: 'x²', shift: 'x³' },
    { id: 'power', main: 'x^', shift: 'ⁿ√' },
    { id: 'log', main: 'log', shift: '10ˣ' },
    { id: 'ln', main: 'ln', shift: 'eˣ' },

    { id: 'neg', main: '(−)', shift: '∠', alpha: 'A' },
    { id: 'dms', main: '°\'"', alpha: 'B' },
    { id: 'hyp', main: 'hyp', shift: 'Abs', alpha: 'C' },
    { id: 'sin', main: 'sin', shift: 'sin⁻¹', alpha: 'D' },
    { id: 'cos', main: 'cos', shift: 'cos⁻¹', alpha: 'E' },
    { id: 'tan', main: 'tan', shift: 'tan⁻¹', alpha: 'F' },

    { id: 'rcl', main: 'RCL', shift: 'STO' },
    { id: 'eng', main: 'ENG', shift: '←', alpha: 'i' },
    { id: 'lparen', main: '(', shift: '%' },
    { id: 'rparen', main: ')', shift: ',', alpha: 'X' },
    { id: 'sd', main: 'S⇔D', shift: 'a/b/c', alpha: 'Y' },
    { id: 'mplus', main: 'M+', shift: 'M−', alpha: 'M' }
  ];

  var PAD2 = [
    { id: 'd7', main: '7', shift: 'CONST', type: 'num' },
    { id: 'd8', main: '8', shift: 'CONV', type: 'num' },
    { id: 'd9', main: '9', shift: 'CLR', type: 'num' },
    { id: 'del', main: 'DEL', type: 'orange' },
    { id: 'ac', main: 'AC', shift: 'OFF', type: 'orange' },

    { id: 'd4', main: '4', type: 'num' },
    { id: 'd5', main: '5', type: 'num' },
    { id: 'd6', main: '6', type: 'num' },
    { id: 'mul', main: '×', shift: 'nPr', type: 'num' },
    { id: 'div', main: '÷', shift: 'nCr', type: 'num' },

    { id: 'd1', main: '1', type: 'num' },
    { id: 'd2', main: '2', type: 'num' },
    { id: 'd3', main: '3', type: 'num' },
    { id: 'add', main: '+', shift: 'Pol', type: 'num' },
    { id: 'sub', main: '−', shift: 'Rec', type: 'num' },

    { id: 'd0', main: '0', shift: 'Rnd', type: 'num' },
    { id: 'dot', main: '•', shift: 'Ran#', alpha: 'RanInt', type: 'num' },
    { id: 'exp', main: '×10ˣ', shift: 'π', alpha: 'e', type: 'num' },
    { id: 'ans', main: 'Ans', shift: 'DRG▸', type: 'num' },
    { id: 'exe', main: '=', shift: '▶', type: 'exe num' }
  ];

  /* ====================================================================== *
   *  8. state
   * ==================================================================== */
  var S = freshState();

  function freshState() {
    return {
      power: true,
      expr: '', cur: 0, frozenExpr: '',
      shift: false, alpha: false,
      sto: false, rcl: false,
      angle: 'D', io: 'Math', mix: 'improper',
      fix: null, sci: null, norm: 1,
      vars: {}, mem: 0, ans: 0,
      hist: [], histIdx: null, histBrowse: false,
      result: null, justEval: false,
      menu: null, prompt: null, promptBuf: '',
      error: null, eng: null,
      calcCtx: null, solveFail: false,
      stmts: null, stmtIdx: 0,
      forceDec: false,
      memoryMsg: ''
    };
  }
  function resetState() { S = freshState(); }

  function cfg() { return { fix: S.fix, sci: S.sci, norm: S.norm, mix: S.mix }; }
  function ctxObj() {
    return { angle: S.angle, vars: S.vars, ans: S.ans, fix: S.fix, sci: S.sci, norm: S.norm };
  }

  /* ====================================================================== *
   *  9. editing
   * ==================================================================== */
  function insert(text) {
    if (S.justEval) {
      /* fresh input after a result */
      if (/^[+\-−×÷]$/.test(text)) {
        S.expr = 'Ans' + text;
      } else {
        S.expr = text;
        S.result = null;
      }
      S.cur = S.expr.length;
      S.justEval = false;
      S.eng = null;
      S.histIdx = null;
      return;
    }
    S.expr = S.expr.slice(0, S.cur) + text + S.expr.slice(S.cur);
    S.cur += text.length;
    S.eng = null;
    S.histIdx = null;
  }

  /* index of the '(' matching the ')' at s[closeIdx] */
  function matchParenBack(s, closeIdx) {
    var d = 0;
    for (var i = closeIdx; i >= 0; i--) {
      if (s[i] === ')') d++;
      else if (s[i] === '(') { d--; if (d === 0) return i; }
    }
    return -1;
  }

  /* DEL removes a whole function template ( name( ) ) in one press */
  var FUNC_TEMPLATES = ['d/dx', 'sinh⁻¹', 'cosh⁻¹', 'tanh⁻¹', 'sin⁻¹', 'cos⁻¹', 'tan⁻¹',
    'sinh', 'cosh', 'tanh', 'asin', 'acos', 'atan', 'asinh', 'acosh', 'atanh',
    'RanInt', 'Rnd', 'log', 'ln', 'sin', 'cos', 'tan', 'nPr', 'nCr', 'Abs', 'abs',
    'Pol', 'Rec', '√', '∛', 'ⁿ√', 'Σ', '∫'];

  function templateStart(s, open) {
    for (var i = 0; i < FUNC_TEMPLATES.length; i++) {
      var name = FUNC_TEMPLATES[i];
      var st = open - name.length;
      if (st >= 0 && s.slice(st, open) === name) {
        if (st > 0 && isWordChar(s[st - 1])) continue;
        return st;
      }
    }
    return -1;
  }

  function backspace() {
    if (S.cur <= 0) return;
    var s = S.expr;
    var c = s[S.cur - 1];
    var from = S.cur - 1;
    if (c === ')') {
      var open = matchParenBack(s, from);
      if (open >= 0 && open < from) {
        var st = templateStart(s, open);
        if (st >= 0) from = st;                 /* delete name( ) as one unit */
      }
    } else if (c === '(') {
      var st2 = templateStart(s, from);
      if (st2 >= 0) from = st2;
    }
    s = s.slice(0, from) + s.slice(S.cur);
    S.cur = from;
    S.expr = s;
    S.eng = null;
  }

  /* ====================================================================== *
   * 10. menus
   * ==================================================================== */
  function menu(title, items, per) { return { title: title, items: items, page: 0, per: per || 6 }; }

  var MENUS = {
    setup1: function () {
      return menu('SETUP', [
        { k: '1', label: 'MthIO', act: 'io-math' },
        { k: '2', label: 'LineIO', act: 'io-line' },
        { k: '3', label: 'Deg', act: 'ang-D' },
        { k: '4', label: 'Rad', act: 'ang-R' },
        { k: '5', label: 'Gra', act: 'ang-G' },
        { k: '6', label: 'Fix', act: 'ask-fix' },
        { k: '7', label: 'Sci', act: 'ask-sci' },
        { k: '8', label: 'Norm', act: 'ask-norm' }
      ], 8);
    },
    setup2: function () {
      return menu('SETUP', [
        { k: '1', label: 'ab/c', act: 'ask-frac' },
        { k: '2', label: 'Disp', act: 'disp' },
        { k: '3', label: 'CMPLX', act: 'cmplx' },
        { k: '4', label: 'STAT', act: 'stat' },
        { k: '5', label: 'CONT', act: 'contrast' }
      ], 5);
    },
    const1: function () {
      return menu('CONST', [
        { k: '1', label: 'π', act: 'ins-π' },
        { k: '2', label: 'e', act: 'ins-e' },
        { k: '3', label: 'mol', act: 'cmplx' },
        { k: '4', label: 'ℼ', act: 'cmplx' },
        { k: '5', label: 'g', act: 'cmplx' },
        { k: '6', label: '(Au)', act: 'cmplx' },
        { k: '7', label: '(Rr)', act: 'cmplx' },
        { k: '8', label: '(Re)', act: 'cmplx' },
        { k: '9', label: 'a₀', act: 'cmplx' },
        { k: '0', label: '℧', act: 'cmplx' }
      ], 10);
    },
    conv1: function () {
      return menu('CONV', [
        { k: '1', label: 'Metric/Imp', act: 'cmplx' },
        { k: '2', label: 'Energy', act: 'cmplx' },
        { k: '3', label: 'Temp', act: 'cmplx' },
        { k: '4', label: 'Area', act: 'cmplx' },
        { k: '5', label: 'Volume', act: 'cmplx' },
        { k: '6', label: 'Speed', act: 'cmplx' },
        { k: '7', label: 'Pressure', act: 'cmplx' },
        { k: '8', label: 'Mass', act: 'cmplx' },
        { k: '9', label: 'Data', act: 'cmplx' }
      ], 9);
    },
    hyp: function () {
      return menu('hyp', [
        { k: '1', label: 'sinh', act: 'ins-sinh(' },
        { k: '2', label: 'cosh', act: 'ins-cosh(' },
        { k: '3', label: 'tanh', act: 'ins-tanh(' },
        { k: '4', label: 'sinh⁻¹', act: 'ins-sinh⁻¹(' },
        { k: '5', label: 'cosh⁻¹', act: 'ins-cosh⁻¹(' },
        { k: '6', label: 'tanh⁻¹', act: 'ins-tanh⁻¹(' }
      ]);
    },
    clr: function () {
      return menu('CLR', [
        { k: '1', label: 'Setup', act: 'clr-setup' },
        { k: '2', label: 'Memory', act: 'clr-memory' },
        { k: '3', label: 'All', act: 'clr-all' }
      ]);
    },
    drg: function () {
      return menu('DRG▶', [
        { k: '1', label: '°', act: 'drg-D' },
        { k: '2', label: 'r', act: 'drg-R' },
        { k: '3', label: 'g', act: 'drg-G' }
      ]);
    },
    fix: function () {
      return menu('Fix', [
        { k: '0', label: '0', act: 'fix-0' }, { k: '1', label: '1', act: 'fix-1' },
        { k: '2', label: '2', act: 'fix-2' }, { k: '3', label: '3', act: 'fix-3' },
        { k: '4', label: '4', act: 'fix-4' }, { k: '5', label: '5', act: 'fix-5' },
        { k: '6', label: '6', act: 'fix-6' }, { k: '7', label: '7', act: 'fix-7' },
        { k: '8', label: '8', act: 'fix-8' }, { k: '9', label: '9', act: 'fix-9' }
      ]);
    },
    sci: function () {
      return menu('Sci', [
        { k: '1', label: '1', act: 'sci-1' }, { k: '2', label: '2', act: 'sci-2' },
        { k: '3', label: '3', act: 'sci-3' }, { k: '4', label: '4', act: 'sci-4' },
        { k: '5', label: '5', act: 'sci-5' }, { k: '6', label: '6', act: 'sci-6' },
        { k: '7', label: '7', act: 'sci-7' }, { k: '8', label: '8', act: 'sci-8' },
        { k: '9', label: '9', act: 'sci-9' }, { k: '0', label: '10', act: 'sci-10' }
      ]);
    },
    norm: function () {
      return menu('Norm', [
        { k: '1', label: 'Norm 1', act: 'norm-1' },
        { k: '2', label: 'Norm 2', act: 'norm-2' }
      ]);
    },
    fracset: function () {
      return menu('ab/c', [
        { k: '1', label: 'Math 1/2', act: 'frac-math' },
        { k: '2', label: 'Line 1/2', act: 'frac-line' }
      ]);
    },
    mode: function () {
      return menu('MODE', [
        { k: '1', label: 'COMP', act: 'mode-comp' },
        { k: '2', label: 'CMPLX', act: 'cmplx' },
        { k: '3', label: 'STAT', act: 'stat' },
        { k: '4', label: 'BASE-N', act: 'base-n' },
        { k: '5', label: 'EQN', act: 'eqn' },
        { k: '6', label: 'TABLE', act: 'table' }
      ]);
    }
  };

  function openMenu(which) { S.menu = MENUS[which](); S.error = null; }

  /* full key layout: pad1 is already DOM order (REPLAY spans cols 3-4, rows 1-2) */
  function keySpecs() {
    return { pad1: PAD1.slice(), pad2: PAD2.slice() };
  }

  function menuPage() { return S.menu.items.slice(S.menu.page * S.menu.per, (S.menu.page + 1) * S.menu.per); }
  function menuPages() { return Math.ceil(S.menu.items.length / S.menu.per); }

  function doMenuAction(act) {
    var m;
    if (act.indexOf('ins-') === 0) {
      var txt = act.slice(4);
      S.menu = null;
      insert(txt);
      return;
    }
    if (act.indexOf('fix-') === 0) { S.fix = parseInt(act.slice(4), 10); S.menu = null; return; }
    if (act.indexOf('sci-') === 0) { S.sci = parseInt(act.slice(4), 10); S.menu = null; return; }
    if (act.indexOf('norm-') === 0) { S.norm = parseInt(act.slice(5), 10); S.menu = null; return; }
    switch (act) {
      case 'io-math': S.io = 'Math'; S.menu = null; break;
      case 'io-line': S.io = 'Line'; S.menu = null; break;
      case 'ang-D': S.angle = 'D'; S.menu = null; break;
      case 'ang-R': S.angle = 'R'; S.menu = null; break;
      case 'ang-G': S.angle = 'G'; S.menu = null; break;
      case 'ask-fix': openMenu('fix'); return;
      case 'ask-sci': openMenu('sci'); return;
      case 'ask-norm': openMenu('norm'); return;
      case 'ask-frac': openMenu('fracset'); return;
      case 'frac-math': S.io = 'Math'; S.mix = 'improper'; S.menu = null; break;
      case 'frac-line': S.io = 'Line'; S.mix = 'improper'; S.menu = null; break;
      case 'disp': toast('Display contrast (◀ ▶)'); S.menu = null; break;
      case 'cmplx': toast('CMPLX mode not implemented'); S.menu = null; break;
      case 'stat': toast('STAT mode not implemented'); S.menu = null; break;
      case 'base-n': toast('BASE-N not implemented'); S.menu = null; break;
      case 'eqn': toast('EQN not implemented'); S.menu = null; break;
      case 'table': toast('TABLE not implemented'); S.menu = null; break;
      case 'contrast': toast('Contrast'); S.menu = null; break;
      case 'mode-comp': toast('COMP mode'); S.menu = null; break;
      case 'exit': S.menu = null; break;
      case 'clr-setup': S.menu = null; S.prompt = { kind: 'clr', which: 'setup', buf: '' }; return;
      case 'clr-memory': S.menu = null; S.prompt = { kind: 'clr', which: 'memory', buf: '' }; return;
      case 'clr-all': S.menu = null; S.prompt = { kind: 'clr', which: 'all', buf: '' }; return;
      case 'drg-D': doDrg('D'); break;
      case 'drg-R': doDrg('R'); break;
      case 'drg-G': doDrg('G'); break;
      default: S.menu = null; break;
    }
  }

  function handleMenuKey(kid) {
    if (kid === 'on') { S.power = true; S.menu = null; return; }
    if (kid === 'ac') { S.menu = null; S.error = null; return; }
    if (kid === 'r-up' || kid === 'r-down') {
      /* SETUP has two screens: REPLAY ▼ moves to the ab/c ... CONT screen */
      if (S.menu.title === 'SETUP') {
        S.menu = kid === 'r-down' ? MENUS.setup2() : MENUS.setup1();
        return;
      }
      if (kid === 'r-up') S.menu.page = Math.max(0, S.menu.page - 1);
      else S.menu.page = Math.min(menuPages() - 1, S.menu.page + 1);
      return;
    }
    var dig = DIGIT_ID[kid];
    if (dig !== undefined) {
      var page = menuPage();
      for (var i = 0; i < page.length; i++) if (page[i].k === dig) { doMenuAction(page[i].act); return; }
      return;
    }
  }

  var DIGIT_ID = {
    d0: '0', d1: '1', d2: '2', d3: '3', d4: '4',
    d5: '5', d6: '6', d7: '7', d8: '8', d9: '9'
  };

  function doDrg(from) {
    S.menu = null;
    var v;
    try { v = currentValue(); }
    catch (e) { S.error = e.message; return; }
    if (v === null) { S.error = 'Syntax ERROR'; return; }
    var out = drgConvert(v, from, S.angle);
    setResult(String(v), out, {});
    S.justEval = true;
  }

  /* ====================================================================== *
   * 11. result handling
   * ==================================================================== */
  function setResult(exprText, val, extras) {
    S.result = makeResult(exprText, val, ctxObj());
    if (extras) for (var k in extras) { if (extras[k]) S.result[k] = extras[k]; }
    S.ans = val;
    S.expr = exprText;
    S.cur = exprText.length;
    S.justEval = true;
    S.error = null;
    S.eng = null;
  }

  function currentValue() {
    if (S.justEval && S.result && isFinite(S.result.val)) return S.result.val;
    if (S.expr && S.expr.trim()) {
      try { return evaluateStatement(S.expr); } catch (e) { throw e; }
    }
    return null;
  }

  function evaluateStatement(text) {
    var stmts = splitTop(text, ':');
    var val = null, ctx = ctxObj();
    for (var i = 0; i < stmts.length; i++) {
      var t = stmts[i].trim();
      if (!t) continue;
      val = evaluate(t, ctx);
      ctx.ans = val;
    }
    if (val === null) throw syntax();
    return val;
  }

  /* ---- EXE ---- */
  function doExe() {
    if (S.stmts) return runNextStatement();
    closeOpenParens();
    var text = S.expr.trim();
    if (!text) {
      /* EXE with nothing typed: re-show previous result */
      return;
    }
    var parts = splitTop(text, ':').filter(function (t) { return t.trim(); });
    if (parts.length > 1) {
      S.stmts = parts;
      S.stmtIdx = 0;
      S.frozenExpr = text;
      S.expr = '';
      S.cur = 0;
      runNextStatement();
      return;
    }
    runStatement(text, true);
  }

  /* the real calculator completes open brackets when = is pressed */
  function closeOpenParens() {
    var s = S.expr, open = 0;
    for (var i = 0; i < s.length; i++) {
      if (s[i] === '(') open++;
      else if (s[i] === ')') open--;
      if (open < 0) return;
    }
    if (open > 0) {
      S.expr = s + new Array(open + 1).join(')');
      S.cur = S.expr.length;
    }
  }

  function runNextStatement() {
    if (!S.stmts || S.stmtIdx >= S.stmts.length) { S.stmts = null; return; }
    var st = S.stmts[S.stmtIdx];
    var last = S.stmtIdx === S.stmts.length - 1;
    S.stmtIdx++;
    runStatement(st.trim(), last);
    if (last) S.stmts = null;
  }

  function runStatement(text, pushHistory) {
    var ctx = ctxObj();
    var extras = {};
    try {
      var val = evaluate(text, ctx);
      S.vars = ctx.vars;
      setResult(text, val, extras);
      if (pushHistory) {
        S.hist.push({ expr: text, val: val });
        if (S.hist.length > 100) S.hist.shift();
      }
      S.histIdx = null;
    } catch (e) {
      S.error = e instanceof CalcError ? e.message : 'Math ERROR';
      S.justEval = true;
      S.eng = null;
    }
  }

  /* ====================================================================== *
   * 12. S⇔D / ENG / DMS toggles
   * ==================================================================== */
  function toggleSD() {
    if (!S.result || !S.result.forms.length) return;
    S.result.idx = (S.result.idx + 1) % S.result.forms.length;
    S.eng = null;
  }
  function toggleMix() {
    S.mix = S.mix === 'mixed' ? 'improper' : 'mixed';
    if (S.result) { /* re-render uses cfg().mix */ }
  }

  function engCycle(left) {
    var v;
    try { v = currentValue(); } catch (e) { S.error = e.message; return; }
    if (v === null || !isFinite(v)) { S.error = 'Math ERROR'; return; }
    if (!S.eng) {
      var e = v === 0 ? 0 : Math.floor(Math.log10(Math.abs(v)));
      S.eng = { v: v, exp: e, mant: v / Math.pow(10, e) };
    }
    if (left) {
      /* SHIFT+ENG : exp -> 3*floor((e+1)/3), then +3 each press */
      if (!S.eng.leftInit) { S.eng.exp = 3 * Math.floor((S.eng.exp + 1) / 3); S.eng.leftInit = true; }
      else S.eng.exp += 3;
    } else {
      /* ENG : exp -> 3*ceil((e-2)/3), then -3 each press */
      if (!S.eng.rightInit) { S.eng.exp = 3 * Math.ceil((S.eng.exp - 2) / 3); S.eng.rightInit = true; }
      else S.eng.exp -= 3;
    }
    var m = S.eng.v / Math.pow(10, S.eng.exp);
    S.eng.mant = m;
    S.result = {
      expr: trimZeros(m.toPrecision(10)), val: S.eng.v,
      forms: [{ type: 'eng', mant: m, exp: S.eng.exp }], idx: 0
    };
    S.justEval = true;
    S.error = null;
  }

  /* °' " on a result toggles DMS <-> decimal */
  function dmsToggle() {
    if (!S.justEval || !S.result) {
      /* while editing: cycle ° ' " by counting markers in the current group */
      cycleDmsMarkers();
      return;
    }
    var cur = S.result.forms[S.result.idx];
    if (cur && cur.type === 'dms') {
      /* switch to decimal */
      var decIdx = -1;
      for (var i = 0; i < S.result.forms.length; i++) if (S.result.forms[i].type === 'dec') { decIdx = i; break; }
      if (decIdx >= 0) S.result.idx = decIdx;
      else {
        S.result = makeResult(S.result.expr, S.result.val, ctxObj());
      }
      return;
    }
    /* add/activate a dms form */
    var haveDms = -1;
    for (var j = 0; j < S.result.forms.length; j++) if (S.result.forms[j].type === 'dms') haveDms = j;
    if (haveDms >= 0) { S.result.idx = haveDms; return; }
    S.result.forms.unshift({ type: 'dms', v: S.result.val });
    S.result.idx = 0;
  }

  function cycleDmsMarkers() {
    /* look back from the cursor within the current numeric group */
    var s = S.expr, i = S.cur;
    var start = i;
    while (start > 0) {
      var c = s[start - 1];
      if (isDigit(c) || c === '.' || c === '°' || c === "'" || c === '"') start--;
      else break;
    }
    var group = s.slice(start, i);
    var count = (group.match(/[°'"]/g) || []).length;
    if (count >= 3) return;             /* ignore */
    var mark = count === 0 ? '°' : (count === 1 ? "'" : '"');
    S.expr = s.slice(0, i) + mark + s.slice(i);
    S.cur = i + 1;
  }

  /* ====================================================================== *
   * 13. CALC / SOLVE
   * ==================================================================== */
  function startCalc(isSolve) {
    var text = S.expr.trim();
    if (!text) return;
    var eqs = splitTop(text, '=');
    if (eqs.length === 1) {
      /* CALC on an expression: prompt each variable in order of appearance */
      var vars = collectVars(text, []);
      if (!vars.length) { runStatement(text, true); return; }
      S.calcCtx = { mode: 'calc', expr: text, vars: vars, idx: 0 };
      S.prompt = promptFor(vars[0]);
      S.expr = ''; S.cur = 0;
      return;
    }
    if (eqs.length !== 2) { S.error = 'Syntax ERROR'; return; }
    var lhs = eqs[0].trim(), rhs = eqs[1].trim();
    var lm = /^([A-Za-z])\s*$/.exec(lhs);
    var solVar, order;
    if (lm) {
      /* Y = <expr in X>  :  ask for Y first, then X (initial guess) */
      var lhsVar = lm[1].toUpperCase();
      var rhsVars = collectVars(rhs, []);
      solVar = rhsVars.length ? rhsVars[0] : lhsVar;
      order = [lhsVar];
      for (var i = 0; i < rhsVars.length; i++) {
        if (rhsVars[i] === solVar) continue;
        if (order.indexOf(rhsVars[i]) < 0) order.push(rhsVars[i]);
      }
      if (order.indexOf(solVar) < 0) order.push(solVar);
    } else {
      /* <expr in X> = Y  :  ask for X (initial guess), then Y */
      var lv = collectVars(lhs, []);
      var rv = collectVars(rhs, []);
      solVar = rv.length ? rv[0] : (lv.length ? lv[0] : 'X');
      order = [];
      for (var j = 0; j < lv.length; j++) if (lv[j] !== solVar) order.push(lv[j]);
      if (rv.length) order.push(solVar);
      if (!order.length) order = [solVar];
    }
    if (!isSolve) { S.error = 'Syntax ERROR'; return; }
    S.calcCtx = { mode: 'solve', lhs: lhs, rhs: rhs, solVar: solVar, vars: order, idx: 0 };
    S.prompt = promptFor(order[0]);
    S.expr = ''; S.cur = 0;
  }

  function collectVars(text, exclude) {
    var order = [], seen = {};
    var re = /[A-Za-z]/g, m;
    while ((m = re.exec(text))) {
      var L = m[0].toUpperCase();
      if ('ABCDEFXYM'.indexOf(L) < 0) continue;
      if (exclude.indexOf(L) >= 0) continue;
      if (seen[L]) continue;
      seen[L] = true;
      order.push(L);
    }
    return order;
  }

  function promptFor(letter) {
    return { kind: 'var', letter: letter, buf: '' };
  }

  function handlePromptKey(kid) {
    var p = S.prompt;
    if (!p) return;
    if (kid === 'ac') { S.prompt = null; S.calcCtx = null; S.solveFail = false; S.expr = ''; S.cur = 0; return; }
    if (p.kind === 'clr') {
      if (kid === 'exe') { doClear(p.which); S.prompt = null; S.menu = null; }
      return;
    }
    /* variable prompt editing */
    var dig = DIGIT_ID[kid];
    if (dig !== undefined) { p.buf += dig; return; }
    if (kid === 'dot') { if (p.buf.indexOf('.') < 0) p.buf += '.'; return; }
    if (kid === 'sub' || kid === 'neg') {
      p.buf = p.buf.charAt(0) === '-' ? p.buf.slice(1) : '-' + p.buf;
      return;
    }
    if (kid === 'del') { p.buf = p.buf.slice(0, -1); return; }
    if (kid === 'exe') {
      var v = p.buf === '' ? (S.vars[p.letter] !== undefined ? S.vars[p.letter] : 0) : parseFloat(p.buf);
      if (!isFinite(v)) v = 0;
      S.vars[p.letter] = v;
      if (S.calcCtx) {
        S.calcCtx.idx++;
        if (S.calcCtx.idx < S.calcCtx.vars.length) {
          S.prompt = promptFor(S.calcCtx.vars[S.calcCtx.idx]);
          return;
        }
      }
      S.prompt = null;
      finishCalc();
      return;
    }
  }

  function finishCalc() {
    var c = S.calcCtx;
    S.calcCtx = null;
    if (!c) return;
    if (c.mode === 'calc') {
      try {
        var val = evaluate(c.expr, ctxObj());
        setResult(c.expr, val, {});
        S.hist.push({ expr: c.expr, val: val });
      } catch (e) { S.error = e.message; }
      return;
    }
    /* solve */
    var f = makeSolveFn(c);
    var guess = S.vars[c.solVar] !== undefined && S.vars[c.solVar] !== 0 ? S.vars[c.solVar] : 1;
    var root = solveWithFallback(f, guess);
    if (root === null || root === undefined) {
      S.solveFail = true;
      S.expr = c.lhs + '=' + c.rhs;
      S.cur = S.expr.length;
      return;
    }
    S.vars[c.solVar] = root;
    root = cleanNum(root);
    var shown = c.solVar + '=' + String(root);
    setResult(shown, root, {});
    S.expr = shown;
    S.cur = S.expr.length;
    S.hist.push({ expr: shown, val: root });
    S.histIdx = null;
  }

  /* snap solver noise to display precision */
  function cleanNum(v) {
    if (!isFinite(v)) return v;
    if (Math.abs(v) < 1e-11) return 0;
    var r = Number(v.toPrecision(10));
    return Object.is(r, -0) ? 0 : r;
  }

  function makeSolveFn(c) {
    return function (x) {
      var vars = {};
      for (var k in S.vars) if (Object.prototype.hasOwnProperty.call(S.vars, k)) vars[k] = S.vars[k];
      vars[c.solVar] = x;
      var ctx = { angle: S.angle, vars: vars, ans: S.ans, fix: S.fix, sci: S.sci, norm: S.norm };
      var l = evaluate(c.lhs, ctx);
      var r = evaluate(c.rhs, ctx);
      return l - r;
    };
  }

  function doClear(which) {
    if (which === 'setup') {
      S.angle = 'D'; S.io = 'Math'; S.fix = null; S.sci = null; S.norm = 1; S.mix = 'improper';
    } else if (which === 'memory') {
      S.vars = {}; S.mem = 0; S.ans = 0;
    } else {
      resetState();
    }
  }

  /* ====================================================================== *
   * 14. history
   * ==================================================================== */
  function histNav(dir) {
    if (!S.hist.length) return;
    var idx;
    if (S.histIdx === null) idx = dir < 0 ? S.hist.length - 1 : 0;
    else idx = S.histIdx + dir;
    if (idx < 0) idx = 0;
    if (idx > S.hist.length - 1) idx = S.hist.length - 1;
    S.histIdx = idx;
    var h = S.hist[idx];
    S.histBrowse = true;
    S.result = makeResult(h.expr, h.val, ctxObj());
    S.expr = h.expr;
    S.cur = h.expr.length;
    S.justEval = true;
    S.eng = null;
    S.error = null;
  }

  /* EXE / REPLAY ◀▶ on a shown result: bring the expression back for editing */
  function loadCurrentExpr() {
    var text = (S.result && S.result.expr) ? S.result.expr : S.frozenExpr;
    if (!text && S.histIdx !== null) text = S.hist[S.histIdx].expr;
    if (!text) return;
    S.expr = text;
    S.cur = S.expr.length;
    S.justEval = false;
    S.histBrowse = false;
    S.result = null;
    S.eng = null;
  }

  function loadHistExpr() {
    if (S.histIdx === null) return;
    var h = S.hist[S.histIdx];
    S.expr = h.expr;
    S.cur = S.expr.length;
    S.justEval = false;
    S.histBrowse = false;
  }

  /* ====================================================================== *
   * 15. STO / RCL / M+ / M-
   * ==================================================================== */
  function stoOrRclVar(kid, isSto) {
    var L = null;
    var alphaLetter = {
      neg: 'A', dms: 'B', hyp: 'C', sin: 'D', cos: 'E', tan: 'F',
      rparen: 'X', sd: 'Y', mplus: 'M'
    }[kid];
    if (alphaLetter) L = alphaLetter;
    if (!L) return false;
    if (isSto) {
      var v;
      try { v = currentValue(); } catch (e) { S.error = e.message; return true; }
      S.vars[L] = v === null ? 0 : v;
    } else {
      insert(L);
    }
    return true;
  }

  function memOp(sub) {
    var v;
    try { v = currentValue(); } catch (e) { S.error = e.message; return; }
    if (v === null) return;
    S.vars.M = (S.vars.M || 0) + (sub ? -v : v);
    S.mem = S.vars.M;
  }

  /* ====================================================================== *
   * 16. key dispatch
   * ==================================================================== */
  var INSERTS = {
    d0: '0', d1: '1', d2: '2', d3: '3', d4: '4',
    d5: '5', d6: '6', d7: '7', d8: '8', d9: '9',
    dot: '.', add: '+', sub: '-', mul: '×', div: '÷',
    lparen: '(', rparen: ')', frac: '/',
    neg: '(-)', sqrt: '√(', cbrt: '∛(', cube: '³', nthroot: 'ⁿ√(',
    power: '^', square: '²', cube2: '³', fact: '!', inv: '^(-1)',
    exp: '×10^(', pi: 'π', ans: 'Ans',
    log: 'log(', ln: 'ln(', logab: 'log(', comma: ',',
    integral: '∫(', deriv: 'd/dx(', sum: 'Σ(',
    tenx: '10^(', ex: 'e^(', econst: 'e',
    pol: 'Pol(', rec: 'Rec(', abs: 'Abs(',
    sin: 'sin(', cos: 'cos(', tan: 'tan(',
    asin: 'sin⁻¹(', acos: 'cos⁻¹(', atan: 'tan⁻¹(',
    npr: 'nPr(', ncr: 'nCr(',
    randint: 'RanInt(', rnd: 'Rnd', ran: 'Ran#',
    percent: '%',
    A: 'A', B: 'B', C: 'C', D: 'D', E: 'E', F: 'F', X: 'X', Y: 'Y', M: 'M',
    colon: ':', equalkey: '=', angle: '@'
  };

  var SHIFT_ACTIONS = {
    mode: 'setup', calc: 'solve', integral: 'deriv', inv: 'fact', logab: 'sum',
    sqrt: 'cbrt', square: 'cube', power: 'nthroot', log: 'tenx', ln: 'ex',
    neg: 'angle', hyp: 'abs', sin: 'asin', cos: 'acos', tan: 'atan',
    rcl: 'sto', eng: 'eng-left', lparen: 'percent', rparen: 'comma',
    sd: 'mix', mplus: 'mminus',
    d7: 'constmenu', d8: 'convmenu', d9: 'clrmenu',
    mul: 'npr', div: 'ncr', add: 'pol', sub: 'rec',
    d0: 'rnd', dot: 'ran', exp: 'pi', ans: 'drgmenu',
    ac: 'off', exe: 'forcedec'
  };

  var ALPHA_ACTIONS = {
    neg: 'A', dms: 'B', hyp: 'C', sin: 'D', cos: 'E', tan: 'F',
    rparen: 'X', sd: 'Y', mplus: 'M',
    calc: 'equalkey', integral: 'colon',
    dot: 'randint', exp: 'econst', eng: 'complex-i'
  };

  function pressKey(kid) {
    if (!S.power) {
      if (kid === 'on') { S.power = true; render(); }
      return;
    }

    /* shift / alpha latch */
    if (kid === 'shift') { S.shift = !S.shift; S.alpha = false; render(); return; }
    if (kid === 'alpha') { S.alpha = !S.alpha; S.shift = false; render(); return; }

    var shift = S.shift, alpha = S.alpha;
    S.shift = false; S.alpha = false;

    /* error: any key clears it (and is consumed) */
    if (S.error) {
      S.error = null;
      if (kid === 'on' || kid === 'ac') { S.power = kid === 'on'; S.expr = ''; S.cur = 0; S.result = null; }
      render();
      return;
    }

    /* resolve shift/alpha before anything else so SHIFT+AC -> 'off' works */
    var action = kid;
    if (shift && SHIFT_ACTIONS[kid]) action = SHIFT_ACTIONS[kid];
    else if (alpha && ALPHA_ACTIONS[kid]) action = ALPHA_ACTIONS[kid];

    /* power keys (kid may itself be 'on'/'off' or a SHIFT/ALPHA action) */
    if (action === 'on') { S.power = true; render(); return; }
    if (action === 'off') { S.power = false; S.expr = ''; S.cur = 0; render(); return; }

    /* menus & prompts take priority */
    if (S.menu) { handleMenuKey(kid); render(); return; }
    if (S.prompt) { handlePromptKey(kid); render(); return; }
    if (S.solveFail) {
      if (kid === 'ac') { S.solveFail = false; S.expr = ''; S.cur = 0; render(); return; }
      if (kid === 'exe') { S.solveFail = false; S.calcCtx = null; render(); return; }
      render(); return;
    }

    /* replay / cursor / history */
    switch (action) {
      case 'r-up': histNav(-1); render(); return;
      case 'r-down': histNav(1); render(); return;
      case 'r-left': if (S.justEval) loadCurrentExpr(); else moveCursor(-1); render(); return;
      case 'r-right': if (S.justEval) loadCurrentExpr(); else moveCursor(1); render(); return;
    }

    switch (action) {
      case 'ac':
        S.expr = ''; S.cur = 0; S.result = null; S.justEval = false;
        S.error = null; S.eng = null; S.histIdx = null; S.stmts = null;
        S.calcCtx = null; S.solveFail = false;
        render(); return;
      case 'del':
        if (S.justEval) { render(); return; }
        backspace(); render(); return;
      case 'exe':
        if (S.justEval) loadCurrentExpr();
        doExe(); render(); return;
      case 'forcedec':
        if (S.result) {
          S.result.forms = [{ type: 'dec' }];
          S.result.idx = 0;
          S.justEval = true;
        }
        render(); return;
      case 'mode': openMenu('mode'); render(); return;
      case 'setup': openMenu('setup1'); render(); return;
      case 'setupp2': openMenu('setup2'); render(); return;
      case 'hyp': openMenu('hyp'); render(); return;
      case 'clrmenu': openMenu('clr'); render(); return;
      case 'drgmenu': openMenu('drg'); render(); return;
      case 'constmenu': openMenu('const1'); render(); return;
      case 'convmenu': openMenu('conv1'); render(); return;
      case 'calc': startCalc(false); render(); return;
      case 'solve': startCalc(true); render(); return;
      case 'sd': toggleSD(); render(); return;
      case 'mix': toggleMix(); render(); return;
      case 'dms':
        if (shift || alpha) { /* handled below */ }
        if (S.justEval) { dmsToggle(); render(); return; }
        cycleDmsMarkers(); render(); return;
      case 'eng':
        engCycle(false); render(); return;
      case 'eng-left':
        engCycle(true); render(); return;
      case 'mplus': memOp(false); render(); return;
      case 'mminus': memOp(true); render(); return;
      case 'sto': S.sto = true; render(); return;
      case 'rcl': S.rcl = true; render(); return;
      case 'complex-i': toast('CMPLX i not implemented'); render(); return;
      case 'angle': toast('∠ (CMPLX) not implemented'); render(); return;
      default: break;
    }

    /* STO/RCL waiting for a variable key */
    if (S.sto || S.rcl) {
      var handled = stoOrRclVar(kid, S.sto);
      S.sto = false; S.rcl = false;
      if (handled) { render(); return; }
      render(); return;
    }

    /* insertion */
    var ins = INSERTS[action];
    if (ins !== undefined) {
      insert(ins);
      render(); return;
    }

    render();
  }

  function moveCursor(dir) {
    S.cur += dir;
    if (S.cur < 0) S.cur = 0;
    if (S.cur > S.expr.length) S.cur = S.expr.length;
  }

  /* ====================================================================== *
   * 17. DOM / rendering
   * ==================================================================== */
  var el = {};

  function $(id) { return typeof document !== 'undefined' ? document.getElementById(id) : null; }

  function buildKeypad() {
    var p1 = $('pad1'), p2 = $('pad2');
    if (!p1 || !p2) return;
    [p1, p2].forEach(function (cont) { cont.innerHTML = ''; });
    PAD1.forEach(function (k) {
      if (k.replay) {
        var wrap = document.createElement('div');
        wrap.id = 'replay';
        wrap.innerHTML =
          '<button class="rp up" data-k="r-up" title="History up">&#9650;</button>' +
          '<button class="rp dn" data-k="r-down" title="History down">&#9660;</button>' +
          '<button class="rp lf" data-k="r-left" title="Cursor left">&#9664;</button>' +
          '<button class="rp rt" data-k="r-right" title="Cursor right">&#9654;</button>' +
          '<span class="cap">REPLAY</span>';
        p1.appendChild(wrap);
        return;
      }
      p1.appendChild(makeKey(k));
    });
    PAD2.forEach(function (k) { p2.appendChild(makeKey(k)); });
  }

  function makeKey(k) {
    var b = document.createElement('button');
    b.className = 'key ' + (k.type || '');
    b.dataset.k = k.id;
    var lab = '';
    if (k.shift) lab += '<span class="s">' + esc(k.shift) + '</span>';
    if (k.alpha) lab += '<span class="a' + (k.alpha === 'i' || k.alpha === '∠' ? ' p' : '') + '">' + esc(k.alpha) + '</span>';
    var labHtml = lab ? '<span class="lab">' + lab + '</span>' : '';
    b.innerHTML = labHtml + '<span class="ml">' + esc(k.main) + '</span>';
    return b;
  }

  function render() {
    var line1 = $('line1'), line2 = $('line2'), menuEl = $('menu'), lcd = $('lcd');
    if (!line1 || !line2) return;

    var ind = {
      'i-S': S.shift, 'i-A': S.alpha, 'i-STO': S.sto, 'i-RCL': S.rcl,
      'i-M': (S.vars.M !== undefined && S.vars.M !== 0),
      'i-D': S.angle === 'D', 'i-R': S.angle === 'R', 'i-G': S.angle === 'G',
      'i-Math': S.io === 'Math', 'i-Lin': S.io === 'Line',
      'i-Fix': S.fix !== null, 'i-Sci': S.sci !== null, 'i-Norm': false
    };
    for (var id in ind) {
      var n = $(id);
      if (n) n.classList.toggle('on', !!ind[id]);
    }
    if (lcd) lcd.classList.toggle('off', !S.power);
    var sb = document.querySelector('[data-k="shift"]');
    if (sb) sb.classList.toggle('on-shift', !!S.shift);
    var ab = document.querySelector('[data-k="alpha"]');
    if (ab) ab.classList.toggle('on-alpha', !!S.alpha);

    /* expression line */
    if (S.menu) {
      line1.innerHTML = '';
    } else if (S.prompt) {
      line1.innerHTML = renderPromptLine1(S.prompt);
    } else if (S.power) {
      line1.innerHTML = renderExpr(S.expr, S.cur);
    } else {
      line1.innerHTML = '';
    }

    /* result line */
    if (S.error) {
      line2.innerHTML = '<span class="err">' + esc(S.error) + '</span>';
    } else if (S.solveFail) {
      line2.innerHTML = '<span class="err">Can\'t solve (EXE=cont AC=cancel)</span>';
    } else if (S.prompt) {
      line2.innerHTML = renderPromptLine2(S.prompt);
    } else if (S.eng) {
      line2.innerHTML = sciHTML(S.eng.mant, 10) + '&nbsp;&nbsp;(exp ' + S.eng.exp + ')';
    } else if (S.result) {
      line2.innerHTML = resultHTML(S.result, cfg());
    } else {
      line2.innerHTML = '0';
    }

    /* menu overlay */
    if (menuEl) {
      if (S.menu) {
        menuEl.className = 'on';
        var page = menuPage();
        var html = '';
        for (var i = 0; i < page.length; i++) {
          html += '<div class="mi"><u>' + page[i].k + ':</u>&nbsp;' + page[i].label + '</div>';
        }
        menuEl.innerHTML = html;
      } else {
        menuEl.className = '';
        menuEl.innerHTML = '';
      }
    }
    var up = $('i-up'), dn = $('i-dn');
    if (up) up.classList.toggle('on', !!(S.menu && S.menu.page > 0));
    if (dn) dn.classList.toggle('on', !!(S.menu && menuPages() > 1 && S.menu.page < menuPages() - 1));
  }

  function renderPromptLine1(p) {
    if (p.kind === 'clr') {
      var what = p.which === 'setup' ? 'Setup?' : (p.which === 'memory' ? 'Memory?' : 'All?');
      return esc(what);
    }
    return esc('Value? ' + p.letter);
  }
  function renderPromptLine2(p) {
    if (p.kind === 'clr') return '';
    if (p.buf === '') return '<span class="caret"></span>' + (S.vars[p.letter] !== undefined ? fmtDec(S.vars[p.letter], cfg()) : '');
    return esc(p.buf);
  }

  var toastTimer = null;
  function toast(msg) {
    var t = $('toast');
    if (!t) return;
    t.textContent = msg;
    t.classList.add('on');
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.classList.remove('on'); }, 1600);
  }

  /* ====================================================================== *
   * 18. browser init
   * ==================================================================== */
  function initUI() {
    buildKeypad();
    document.addEventListener('click', function (e) {
      var btn = e.target.closest ? e.target.closest('button[data-k]') : null;
      if (!btn) return;
      pressKey(btn.dataset.k);
    });
    document.addEventListener('keydown', function (e) {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      var k = e.key;
      var handled = true;
      if (k >= '0' && k <= '9') pressKey('d' + k);
      else if (k === '.') pressKey('dot');
      else if (k === '+') pressKey('add');
      else if (k === '-') pressKey('sub');
      else if (k === '*' || k === 'x') pressKey('mul');
      else if (k === '/') pressKey('frac');
      else if (k === '^') pressKey('power');
      else if (k === '(') pressKey('lparen');
      else if (k === ')') pressKey('rparen');
      else if (k === '!') pressKey('fact');
      else if (k === '%') pressKey('percent');
      else if (k === 'Enter' || k === '=') {
        if (e.shiftKey) { S.shift = true; pressKey('exe'); S.shift = false; }
        else pressKey('exe');
      }
      else if (k === 'Backspace' || k === 'Delete') pressKey('del');
      else if (k === 'Escape') pressKey('ac');
      else if (k === 'ArrowUp') pressKey('r-up');
      else if (k === 'ArrowDown') pressKey('r-down');
      else if (k === 'ArrowLeft') pressKey('r-left');
      else if (k === 'ArrowRight') pressKey('r-right');
      else if (k === 'p' || k === 'P') pressKey('pi');
      else if (k === 'e' || k === 'E') pressKey('econst');
      else if (k === 'r' || k === 'R') pressKey('sqrt');
      else if (k === 'i' || k === 'I') pressKey('nthroot');
      else if (k === 's' || k === 'S') pressKey('sin');
      else if (k === 'c' || k === 'C') pressKey('cos');
      else if (k === 't' || k === 'T') pressKey('tan');
      else if (k === 'l' || k === 'L') pressKey('log');
      else if (k === 'n' || k === 'N') pressKey('ln');
      else if (k === 'h' || k === 'H') pressKey('hyp');
      else if (k === 'a' || k === 'A') pressKey('alpha');
      else if (k === 'd' || k === 'D') pressKey('deriv');
      else if (k === 'o' || k === 'O') pressKey('integral');
      else if (k === 'q' || k === 'Q') pressKey('neg');
      else if (k === 'v' || k === 'V') pressKey('eng');
      else if (/^[b-fmxy]$/.test(k)) pressKey(k.toUpperCase());
      else handled = false;
      if (handled) e.preventDefault();
    });
    render();
  }

  /* ====================================================================== *
   * exports
   * ==================================================================== */
  var api = {
    evaluate: evaluate,
    evaluateStatement: evaluateStatement,
    makeResult: makeResult,
    resultHTML: resultHTML,
    renderExpr: renderExpr,
    fmtDec: fmtDec,
    sciHTML: sciHTML,
    toFraction: toFraction,
    toDMS: toDMS,
    drgConvert: drgConvert,
    simplifyRadical: simplifyRadical,
    factorial: factorial,
    toRad: toRad,
    fromRad: fromRad,
    solveX: solveX,
    solveWithFallback: solveWithFallback,
    splitTop: splitTop,
    operandStart: operandStart,
    keySpecs: keySpecs,
    CalcError: CalcError,
    state: function () { return S; },
    reset: function () { resetState(); },
    pressKey: pressKey,
    render: render,
    toast: toast,
    initUI: initUI,
    menus: MENUS
  };

  if (typeof document !== 'undefined' && document.getElementById) {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', initUI);
    } else {
      initUI();
    }
  }

  return api;
});
