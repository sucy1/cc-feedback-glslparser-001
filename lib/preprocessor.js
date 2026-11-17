var TokenString = require('glsl-tokenizer/string')

// token types that carry no grammatical meaning
var TRIVIA = {
    'whitespace': 1
  , 'line-comment': 1
  , 'block-comment': 1
}

// sentinel returned when a function-like invocation cannot yet be fully
// read from the tokens seen so far (streaming input may finish mid-call)
var BLOCKED = new Object

module.exports = Preprocessor

function Preprocessor(diagnostics) {
  if(!(this instanceof Preprocessor)) return new Preprocessor(diagnostics)

  this.diagnostics = diagnostics || []
  this.macros = Object.create(null)
  this.condStack = []
  // entries retained between process() calls while waiting for more input
  this.pending = []
}

var proto = Preprocessor.prototype

// ------------------------------------------------------------------
// public API
// ------------------------------------------------------------------

// feed an array of raw glsl-tokenizer tokens, receive the tokens that
// should be handed to the parser (directives preserved, dead branches
// removed, macros expanded).
proto.process = function(tokens) {
  var entries = this.pending.concat(tokens.map(function(tok) {
    return { token: tok, hide: null }
  }))
  this.pending = []
  return this._drive(entries, false)
}

// flush any buffered input at end-of-stream. unmatched conditionals are
// reported here as diagnostics.
proto.end = function() {
  var out = []
  if(this.pending.length) {
    out = this._drive(this.pending, true)
    this.pending = []
  }
  while(this.condStack.length) {
    var frame = this.condStack.pop()
    this._error('unexpected EOF: missing #endif for conditional opened here', frame.token)
  }
  return out
}

// ------------------------------------------------------------------
// expansion engine
// ------------------------------------------------------------------

proto._drive = function(entries, atEnd) {
  var self = this
  var out = []
  var i = 0

  while(i < entries.length) {
    var entry = entries[i]
    var tok = entry.token

    if(tok.type === 'eof') {
      out.push(tok)
      i++
      continue
    }

    if(TRIVIA[tok.type]) {
      if(self._active()) out.push(tok)
      i++
      continue
    }

    if(tok.type === 'preprocessor') {
      var wasActive = self._active()
      if(wasActive) out.push(tok)
      self._directive(tok)
      i++
      continue
    }

    if(!self._active()) {
      i++
      continue
    }

    if(tok.type === 'ident' && self.macros[tok.data] && !(entry.hide && entry.hide[tok.data])) {
      var macro = self.macros[tok.data]

      if(macro.func) {
        var invocation = self._tryInvocation(entries, i, atEnd)
        if(invocation === BLOCKED) break
        if(invocation.error) {
          out.push(tok)
          i++
          continue
        }
        if(invocation.args.length !== macro.params.length) {
          self._error(
            'macro `' + macro.name + '` expects ' + macro.params.length +
            ' argument(s), got ' + invocation.args.length,
            tok
          )
          for(var k = i; k < invocation.next; k++) out.push(entries[k].token)
          i = invocation.next
          continue
        }
        var replacement = self._substitute(macro, invocation.args, tok, entry.hide)
        entries = entries.slice(0, i)
          .concat(replacement)
          .concat(entries.slice(invocation.next))
        continue
      }

      replacement = self._expandObject(macro, tok, entry.hide)
      entries = entries.slice(0, i)
        .concat(replacement)
        .concat(entries.slice(i + 1))
      continue
    }

    out.push(tok)
    i++
  }

  if(i < entries.length) this.pending = entries.slice(i)
  return out
}

// locate the opening paren following a function-macro identifier and
// collect its (balanced, comma separated) argument entries.
proto._tryInvocation = function(entries, start, atEnd) {
  var i = start + 1
  var n = entries.length

  while(i < n && TRIVIA[entries[i].token.type]) i++

  if(i >= n || entries[i].token.type === 'eof') {
    return atEnd ? { error: true } : BLOCKED
  }
  if(entries[i].token.data !== '(') {
    // not actually an invocation -- identifier is used bare
    return { error: true }
  }

  var args = []
  var current = []
  var depth = 0
  i++

  while(i < n) {
    var tok = entries[i].token

    if(tok.type === 'eof') {
      return atEnd ? { error: true } : BLOCKED
    }

    if(tok.data === '(' && tok.type === 'operator') {
      depth++
      current.push(entries[i])
      i++
      continue
    }

    if(tok.data === ')' && tok.type === 'operator') {
      if(depth === 0) {
        args.push(current)
        return { args: args, next: i + 1 }
      }
      depth--
      current.push(entries[i])
      i++
      continue
    }

    if(tok.data === ',' && tok.type === 'operator' && depth === 0) {
      args.push(current)
      current = []
      i++
      continue
    }

    current.push(entries[i])
    i++
  }

  return atEnd ? { error: true } : BLOCKED
}

// object-like macro: splice a stamped copy of the body into the queue
proto._expandObject = function(macro, origin, parentHide) {
  var hide = extendHide(parentHide, macro.name)
  return macro.body.map(function(tok) {
    return { token: stamp(cloneToken(tok), origin, macro.name), hide: hide }
  })
}

// function-like macro: arguments are fully expanded first, then
// substituted for parameters. argument tokens keep their own
// (original source) positions; everything else takes the invocation
// position.
proto._substitute = function(macro, argEntries, origin, parentHide) {
  var self = this

  // arguments are fully macro-expanded before substitution
  var expandedArgs = argEntries.map(function(entries) {
    return self._drive(entries.map(function(e) {
      return { token: cloneToken(e.token), hide: e.hide }
    }), true).map(function(tok) {
      return { token: tok, hide: null }
    })
  })

  var hide = extendHide(parentHide, macro.name)
  var out = []

  macro.body.forEach(function(tok) {
    if(tok.type === 'ident') {
      var p = macro.params.indexOf(tok.data)
      if(p !== -1) {
        expandedArgs[p].forEach(function(entry) {
          // argument tokens retain their original source location
          out.push({ token: cloneToken(entry.token), hide: entry.hide || hide })
        })
        return
      }
    }
    out.push({ token: stamp(cloneToken(tok), origin, macro.name), hide: hide })
  })

  return out
}

// ------------------------------------------------------------------
// directives
// ------------------------------------------------------------------

proto._active = function() {
  for(var i = 0; i < this.condStack.length; i++) {
    if(!this.condStack[i].taken) return false
  }
  return true
}

proto._directive = function(tok) {
  var parsed = parseDirective(tok.data)
  if(!parsed.name) {
    if(this._active()) this._error('invalid preprocessor directive', tok)
    return
  }

  switch(parsed.name) {
    case 'define': return this._define(parsed.rest, tok)
    case 'undef': return this._undef(parsed.rest, tok)
    case 'if': return this._if(parsed.rest, tok)
    case 'ifdef': return this._ifdef(parsed.rest, true, tok)
    case 'ifndef': return this._ifdef(parsed.rest, false, tok)
    case 'elif': return this._elif(parsed.rest, tok)
    case 'else': return this._else(tok)
    case 'endif': return this._endif(tok)
    default:
      // #version, #extension, #line, #pragma, ... -- nothing to do,
      // the token itself was already emitted for the AST
      return
  }
}

proto._define = function(rest, tok) {
  if(!this._active()) return

  var match = /^([A-Za-z_]\w*)[ \t]*(?:\(([^)]*)\))?[ \t]*/.exec(rest)
  if(!match) {
    this._error('invalid #define directive', tok)
    return
  }

  var name = match[1]
  var isFunction = rest.charAt(name.length) === '('
  var params = []
  var bodyText

  if(isFunction) {
    var paramText = match[2] || ''
    params = paramText.length
      ? paramText.split(',').map(function(s) { return s.trim() }).filter(Boolean)
      : []
    bodyText = rest.slice(name.length + paramText.length + 2).replace(/^[ \t]+/, '')
  } else {
    bodyText = rest.slice(name.length).replace(/^[ \t]+/, '')
  }

  // the tokenizer only assigns a token's type when it sees the
  // character *after* it; a fragment ending on an identifier would
  // otherwise yield a typeless token. trailing newline fixes that and
  // is itself discarded by the trivia filter.
  var body = tokenizeFragment(bodyText)

  this.macros[name] = {
      name: name
    , func: isFunction
    , params: params
    , body: body
    , token: tok
  }
}

proto._undef = function(rest, tok) {
  if(!this._active()) return
  var name = rest.trim().split(/[ \t]/)[0]
  if(!/^[A-Za-z_]\w*$/.test(name)) {
    this._error('invalid #undef directive', tok)
    return
  }
  delete this.macros[name]
}

proto._if = function(rest, tok) {
  var parentActive = this._active()
  var value = parentActive ? this._eval(rest, tok) : 0
  this.condStack.push({
      taken: parentActive && !!value
    , parentActive: parentActive
    , done: !!(parentActive && value)
    , inElse: false
    , token: tok
  })
}

proto._ifdef = function(rest, expectDefined, tok) {
  var parentActive = this._active()
  var name = rest.trim().split(/[ \t]/)[0]
  var defined = !!this.macros[name]
  var taken = parentActive && (defined === expectDefined)
  this.condStack.push({
      taken: taken
    , parentActive: parentActive
    , done: taken
    , inElse: false
    , token: tok
  })
}

proto._elif = function(rest, tok) {
  var frame = this.condStack[this.condStack.length - 1]
  if(!frame) {
    this._error('#elif without matching #if', tok)
    return
  }
  if(frame.inElse) {
    this._error('#elif after #else', tok)
    return
  }
  var value = frame.parentActive ? this._eval(rest, tok) : 0
  frame.taken = frame.parentActive && !frame.done && !!value
  if(frame.taken) frame.done = true
}

proto._else = function(tok) {
  var frame = this.condStack[this.condStack.length - 1]
  if(!frame) {
    this._error('#else without matching #if', tok)
    return
  }
  if(frame.inElse) {
    this._error('duplicate #else', tok)
    return
  }
  frame.inElse = true
  frame.taken = frame.parentActive && !frame.done
  if(frame.taken) frame.done = true
}

proto._endif = function(tok) {
  if(!this.condStack.length) {
    this._error('#endif without matching #if', tok)
    return
  }
  this.condStack.pop()
}

// ------------------------------------------------------------------
// constant-expression evaluation for #if / #elif
// ------------------------------------------------------------------

proto._eval = function(exprText, refToken) {
  var self = this
  var raw = tokenizeFragment(exprText)

  // C preprocessor semantics: macro expansion happens *before* constant
  // expression evaluation, and `defined(...)` / `defined ...` must be
  // resolved during that expansion pass.
  var expanded = []
  for(var i = 0; i < raw.length; i++) {
    var t = raw[i]
    if(t.type === 'ident' && t.data === 'defined') {
      var j = i + 1
      var paren = false
      if(raw[j] && raw[j].data === '(') { paren = true; j++ }
      var target = raw[j]
      if(!target || target.type !== 'ident') {
        this._error('malformed defined() operator', refToken)
        expanded.push(intToken(0))
        i = j
        continue
      }
      expanded.push(intToken(this.macros[target.data] ? 1 : 0))
      i = paren ? j + 1 : j
      continue
    }

    if(t.type === 'ident' && this.macros[t.data]) {
      var macro = this.macros[t.data]
      if(macro.func) {
        // function-like macro without an invocation in an #if expression
        this._error('function-like macro `' + macro.name + '` invoked without arguments', refToken)
        expanded.push(intToken(0))
        continue
      }
      macro.body.forEach(function(bodyTok) {
        expanded.push(cloneToken(bodyTok))
      })
      continue
    }

    expanded.push(t)
  }

  // any identifiers still present have no definition -> evaluate as 0
  var rewritten = expanded.map(function(tok) {
    return tok.type === 'ident' ? intToken(0) : cloneToken(tok)
  })

  try {
    var state = { tokens: rewritten, index: 0, macros: this.macros }
    var value = evalTernary(state)
    if(state.index !== rewritten.length) {
      this._error('invalid preprocessor expression: ' + exprText, refToken)
      return 0
    }
    return value ? 1 : 0
  } catch(err) {
    this._error('invalid preprocessor expression: ' + exprText, refToken)
    return 0
  }
}

// ------------------------------------------------------------------
// diagnostics
// ------------------------------------------------------------------

proto._error = function(message, token) {
  var diag = {
      type: 'error'
    , source: 'preprocessor'
    , message: message
  }
  if(token && typeof token.line === 'number') {
    // report a 1-based start column like node.loc, even though the
    // directive token spans the whole line.
    var startColumn = typeof token.data === 'string' && token.data.length
      ? Math.max(1, token.column - token.data.length + 1)
      : token.column
    diag.line = token.line
    diag.column = startColumn
    diag.position = token.position
    diag.loc = {
        start: { line: token.line, column: startColumn, position: token.position }
    }
    if(typeof token.data === 'string') {
      diag.loc.end = {
          line: token.line
        , column: token.column + 1
        , position: token.position + token.data.length
      }
    }
    diag.actual = { type: token.type, data: token.data }
  }
  this.diagnostics.push(diag)
}

// ------------------------------------------------------------------
// helpers
// ------------------------------------------------------------------

function extendHide(parentHide, name) {
  var hide = Object.create(parentHide || null)
  hide[name] = true
  return hide
}

function cloneToken(tok) {
  var copy = {}
  for(var key in tok) copy[key] = tok[key]
  return copy
}

// force every expanded token to point back at the macro invocation in
// the original source -- line/column must never reflect expansion text
function stamp(tok, origin, macroName) {
  tok.position = origin.position
  tok.line = origin.line
  tok.column = origin.column
  tok.macroExpansion = macroName
  return tok
}

function intToken(value) {
  return { type: 'integer', data: String(value), position: 0, line: 1, column: 0 }
}

// tokenize a macro body or #if expression fragment. a trailing newline
// guarantees the final token gets its type assigned, and trivia/eof are
// stripped since they play no role in expansion or evaluation.
function tokenizeFragment(text) {
  return TokenString(text + '\n')
    .filter(function(t) { return t.type !== 'eof' && !TRIVIA[t.type] })
    .map(cloneToken)
}

// split a raw preprocessor token's text into directive name + remainder,
// collapsing backslash-newline line continuations.
function parseDirective(data) {
  var flat = data.replace(/\\\r?\n/g, ' ')
  var match = /^[ \t]*#[ \t]*([A-Za-z_]\w*)?/.exec(flat)
  if(!match) return { name: null, rest: '' }
  return {
      name: match[1] || null
    , rest: flat.slice(match[0].length).replace(/^[ \t]+/, '').replace(/[ \t]+$/, '')
  }
}

// --- tiny recursive-descent evaluator --------------------------------

function peek(s) {
  return s.tokens[s.index] || null
}

function next(s) {
  return s.tokens[s.index++] || null
}

function binaryLevel(sub, operators) {
  return function(s) {
    var left = sub(s)
    var t
    while((t = peek(s)) && t.type === 'operator' && operators.indexOf(t.data) !== -1) {
      next(s)
      var right = sub(s)
      left = applyOp(t.data, left, right)
    }
    return left
  }
}

function evalTernary(s) {
  var cond = evalLogicalOr(s)
  var t = peek(s)
  if(t && t.data === '?') {
    next(s)
    var left = evalTernary(s)
    if(!peek(s) || peek(s).data !== ':') throw new Error('expected :')
    next(s)
    var right = evalTernary(s)
    return cond ? left : right
  }
  return cond
}

function evalLogicalOr(s) { return binaryLevel(evalLogicalAnd, ['||'])(s) }
function evalLogicalAnd(s) { return binaryLevel(evalBitOr, ['&&'])(s) }
function evalBitOr(s) { return binaryLevel(evalBitXor, ['|'])(s) }
function evalBitXor(s) { return binaryLevel(evalBitAnd, ['^'])(s) }
function evalBitAnd(s) { return binaryLevel(evalEquality, ['&'])(s) }
function evalEquality(s) { return binaryLevel(evalRelational, ['==', '!='])(s) }
function evalRelational(s) { return binaryLevel(evalShift, ['<', '<=', '>', '>='])(s) }
function evalShift(s) { return binaryLevel(evalAdditive, ['<<', '>>'])(s) }
function evalAdditive(s) { return binaryLevel(evalMultiplicative, ['+', '-'])(s) }
function evalMultiplicative(s) { return binaryLevel(evalUnary, ['*', '/', '%'])(s) }

function evalUnary(s) {
  var t = peek(s)
  if(t && t.type === 'operator' && (t.data === '!' || t.data === '~' || t.data === '-' || t.data === '+')) {
    next(s)
    var v = evalUnary(s)
    switch(t.data) {
      case '!': return v ? 0 : 1
      case '~': return ~v
      case '-': return -v
      case '+': return +v
    }
  }
  return evalPrimary(s)
}

function evalPrimary(s) {
  var t = next(s)
  if(!t) throw new Error('unexpected end of expression')

  if(t.data === '(' && t.type === 'operator') {
    var v = evalTernary(s)
    var close = next(s)
    if(!close || close.data !== ')') throw new Error('expected )')
    return v
  }

  if(t.type === 'integer') {
    if(/^0[xX]/.test(t.data)) return parseInt(t.data, 16)
    return parseInt(t.data, 10) || 0
  }

  if(t.type === 'float') return parseInt(parseFloat(t.data), 10) || 0

  // identifiers without a macro definition evaluate to zero in
  // preprocessor constant expressions
  return 0
}

function applyOp(op, a, b) {
  switch(op) {
    case '||': return (a || b) ? 1 : 0
    case '&&': return (a && b) ? 1 : 0
    case '|': return a | b
    case '^': return a ^ b
    case '&': return a & b
    case '==': return a === b ? 1 : 0
    case '!=': return a !== b ? 1 : 0
    case '<': return a < b ? 1 : 0
    case '<=': return a <= b ? 1 : 0
    case '>': return a > b ? 1 : 0
    case '>=': return a >= b ? 1 : 0
    case '<<': return a << b
    case '>>': return a >> b
    case '+': return a + b
    case '-': return a - b
    case '*': return a * b
    case '/': return b === 0 ? 0 : (a / b) | 0
    case '%': return b === 0 ? 0 : a % b
  }
  throw new Error('unsupported operator ' + op)
}
