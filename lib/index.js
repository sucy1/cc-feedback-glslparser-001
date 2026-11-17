module.exports = parser

var full_parse_expr = require('./expr')
  , Scope = require('./scope')

// singleton!
var Advance = new Object

var DEBUG = false

var _ = 0
  , IDENT = _++
  , STMT = _++
  , STMTLIST = _++
  , STRUCT = _++
  , FUNCTION = _++
  , FUNCTIONARGS = _++
  , DECL = _++
  , DECLLIST = _++
  , FORLOOP = _++
  , WHILELOOP = _++
  , IF = _++
  , EXPR = _++
  , PRECISION = _++
  , COMMENT = _++
  , PREPROCESSOR = _++
  , KEYWORD = _++
  , KEYWORD_OR_IDENT = _++
  , RETURN = _++
  , BREAK = _++
  , CONTINUE = _++
  , DISCARD = _++
  , DOWHILELOOP = _++
  , PLACEHOLDER = _++
  , QUANTIFIER = _++

var DECL_ALLOW_ASSIGN = 0x1
  , DECL_ALLOW_COMMA = 0x2
  , DECL_REQUIRE_NAME = 0x4
  , DECL_ALLOW_INVARIANT = 0x8
  , DECL_ALLOW_STORAGE = 0x10
  , DECL_NO_INOUT = 0x20
  , DECL_ALLOW_STRUCT = 0x40
  , DECL_STATEMENT = 0xFF
  , DECL_FUNCTION = DECL_STATEMENT & ~(DECL_ALLOW_ASSIGN | DECL_ALLOW_COMMA | DECL_NO_INOUT | DECL_ALLOW_INVARIANT | DECL_REQUIRE_NAME)
  , DECL_STRUCT = DECL_STATEMENT & ~(DECL_ALLOW_ASSIGN | DECL_ALLOW_INVARIANT | DECL_ALLOW_STORAGE | DECL_ALLOW_STRUCT)

var QUALIFIERS = ['const', 'attribute', 'uniform', 'varying']

// internal control-flow signal: a syntax error has already been turned
// into a diagnostic entry; the top-level write() loop catches this and
// performs error recovery. genuine bugs (TypeErrors etc.) propagate.
var ParseSignal = function(diagnostic) {
  this.diagnostic = diagnostic
}
ParseSignal.prototype = Object.create(Error.prototype)

var NO_ASSIGN_ALLOWED = false
  , NO_COMMA_ALLOWED = false

// map of tokens to stmt types
var token_map = {
    'block-comment': COMMENT
  , 'line-comment': COMMENT
  , 'preprocessor': PREPROCESSOR
}

// map of stmt types to human
var stmt_type = _ = [
    'ident'
  , 'stmt'
  , 'stmtlist'
  , 'struct'
  , 'function'
  , 'functionargs'
  , 'decl'
  , 'decllist'
  , 'forloop'
  , 'whileloop'
  , 'if'
  , 'expr'
  , 'precision'
  , 'comment'
  , 'preprocessor'
  , 'keyword'
  , 'keyword_or_ident'
  , 'return'
  , 'break'
  , 'continue'
  , 'discard'
  , 'do-while'
  , 'placeholder'
  , 'quantifier'
]

function parser() {
  var stmtlist = n(STMTLIST)
    , stmt = n(STMT)
    , decllist = n(DECLLIST)
    , precision = n(PRECISION)
    , ident = n(IDENT)
    , keyword_or_ident = n(KEYWORD_OR_IDENT)
    , fn = n(FUNCTION)
    , fnargs = n(FUNCTIONARGS)
    , forstmt = n(FORLOOP)
    , ifstmt = n(IF)
    , whilestmt = n(WHILELOOP)
    , returnstmt = n(RETURN)
    , dowhilestmt = n(DOWHILELOOP)
    , quantifier = n(QUANTIFIER)

  var parse_struct
    , parse_precision
    , parse_quantifier
    , parse_forloop
    , parse_if
    , parse_return
    , parse_whileloop
    , parse_dowhileloop
    , parse_function
    , parse_function_args

  var check = arguments.length ? [].slice.call(arguments) : []
    , complete = false
    , ended = false
    , depth = 0
    , state = []
    , nodes = []
    , tokens = []
    , whitespace = []
    , errored = false
    , diagnostics = []
    , program
    , token
    , node

  // setup state
  state.shift = special_shift
  state.unshift = special_unshift
  state.fake = special_fake
  state.unexpected = unexpected
  state.scope = new Scope(state)
  state.create_node = function() {
    var n = mknode(IDENT, token)
    n.parent = reader.program
    return n
  }

  setup_stative_parsers()

  // setup root node
  node = stmtlist()
  node.expecting = '(eof)'
  node.mode = STMTLIST
  node.token = {type: '(program)', data: '(program)'}
  program = node
  program.diagnostics = diagnostics

  reader.program = program
  reader.diagnostics = diagnostics
  reader.scope = function(scope) {
    if(arguments.length === 1) {
      state.scope = scope
    }
    return state.scope
  }

  state.unshift(node)
  return reader

  function reader(data) {
    if (data === null) {
      return end(), program
    }

    nodes = []
    write(data)
    return nodes
  }

  // stream functions ---------------------------------------------

  function write(input) {
    if(input.type === 'whitespace' || input.type === 'line-comment' || input.type === 'block-comment') {

      whitespace.push(input)
      return
    }
    tokens.push(input)
    token = token || tokens[0]

    if(token && whitespace.length) {
      token.preceding = token.preceding || []
      token.preceding = token.preceding.concat(whitespace)
      whitespace = []
    }

    while(take()) {
      try {
        switch(state[0].mode) {
          case STMT: parse_stmt(); break
          case STMTLIST: parse_stmtlist(); break
          case DECL: parse_decl(); break
          case DECLLIST: parse_decllist(); break
          case EXPR: parse_expr(); break
          case STRUCT: parse_struct(true, true); break
          case PRECISION: parse_precision(); break
          case IDENT: parse_ident(); break
          case KEYWORD: parse_keyword(); break
          case KEYWORD_OR_IDENT: parse_keyword_or_ident(); break
          case FUNCTION: parse_function(); break
          case FUNCTIONARGS: parse_function_args(); break
          case FORLOOP: parse_forloop(); break
          case WHILELOOP: parse_whileloop(); break
          case DOWHILELOOP: parse_dowhileloop(); break
          case RETURN: parse_return(); break
          case IF: parse_if(); break
          case QUANTIFIER: parse_quantifier(); break
        }
      } catch(err) {
        if(!(err instanceof ParseSignal)) throw err
        recover(err)
      }
    }
  }

  // unwind the parser state back to the nearest statement list and
  // discard only the tokens belonging to the broken statement, so
  // parsing can continue and further diagnostics can be collected.
  function recover() {
    // drop half-built frames; keep the root (or enclosing) stmtlist.
    // each popped frame is a node that never completed, so detach it
    // from its parent's child list to avoid a dangling partial node
    // swallowing later statements.
    while(state.length > 1 && state[0].mode !== STMTLIST) {
      var frame = state.shift()

      // an expr frame buffers every token up to its terminator before
      // parsing, so a failure inside it has already consumed tokens for
      // what may be several statements. hand them back to the main queue
      // so the enclosing context can re-parse them instead of losing
      // everything past the error.
      if(frame.mode === EXPR && frame.tokens && frame.tokens.length) {
        tokens = frame.tokens.concat(tokens)
      }

      var parent = state[0]
      if(parent && parent.children) {
        var at = parent.children.indexOf(frame)
        if(at !== -1) parent.children.splice(at, 1)
      }
    }

    // resynchronize within the tokens already buffered: skip the broken
    // remainder up to a statement terminator or the first token that can
    // begin a fresh statement. every iteration consumes at least one
    // token to guarantee forward progress.
    var depth = 0
    var discarded = false
    while(tokens.length && tokens[0].type !== 'eof') {
      var t = tokens[0]
      var isOpen = t.type === 'operator' && (t.data === '{' || t.data === '(')
      var isClose = t.type === 'operator' && (t.data === '}' || t.data === ')')
      var isSemi = t.type === 'operator' && t.data === ';'
      var isStmtStart = t.type === 'keyword' || t.type === 'ident' || t.type === 'builtin'

      if(isClose && depth === 0) break
      if(isSemi && depth === 0) { tokens.shift(); break }
      // stop at a statement-start token, but only after the broken
      // prefix has been discarded so the loop cannot stall on entry
      if(isStmtStart && depth === 0 && discarded) break

      if(isOpen) depth++
      if(isClose) depth--
      tokens.shift()
      discarded = true
    }

    // point the node cursor back at the surviving frame so subsequent
    // nodes attach to the right parent
    node = state[0]
    errored = false
    token = tokens[0]
  }

  function end(tokens) {
    if(arguments.length) {
      write(tokens)
    }

    if(state.length > 1) {
      var openFrame = state[0]
      try {
        unexpected({
            message: 'unexpected EOF'
          , locToken: openFrame && openFrame.token
          , expected: openFrame && openFrame.expecting
        })
      } catch(err) {
        if(!(err instanceof ParseSignal)) throw err
      }
      while(state.length > 1) state.shift()
      node = state[0]
      errored = false
      return
    }

    complete = true
  }

  function take() {
    if(!state.length)
      return false

    return (token = tokens[0])
  }

  // ----- state manipulation --------

  function special_fake(x) {
    state.unshift(x)
    state.shift()
  }

  function special_unshift(_node, add_child) {
    _node.parent = state[0]

    var ret = [].unshift.call(this, _node)

    add_child = add_child === undefined ? true : add_child

    if(DEBUG) {
      var pad = ''
      for(var i = 0, len = this.length - 1; i < len; ++i) {
        pad += ' |'
      }
      console.log(pad, '\\'+_node.type, _node.token.data)
    }

    if(add_child && node !== _node) node.children.push(_node)
    node = _node

    return ret
  }

  function special_shift() {
    var _node = [].shift.call(this)
      , okay = check[this.length]
      , emit = false

    if(DEBUG) {
      var pad = ''
      for(var i = 0, len = this.length; i < len; ++i) {
        pad += ' |'
      }
      console.log(pad, '/'+_node.type)
    }

    if(check.length) {
      if(typeof check[0] === 'function') {
        emit = check[0](_node)
      } else if(okay !== undefined) {
        emit = okay.test ? okay.test(_node.type) : okay === _node.type
      }
    } else {
      emit = true
    }

    if(emit && !errored) nodes.push(_node)

    node = _node.parent
    return _node
  }

  // parse states ---------------

  function parse_stmtlist() {
    // determine the type of the statement
    // and then start parsing
    return stative(
      function() { state.scope.enter(); return Advance }
    , normal_mode
    )()

    function normal_mode() {
      if(token.data === state[0].expecting) {
        return state.scope.exit(), state.shift()
      }
      switch(token.type) {
        case 'preprocessor':
          state.fake(adhoc())
          tokens.shift()
        return
        default:
          state.unshift(stmt())
        return
      }
    }
  }

  function parse_stmt() {
    if(state[0].brace) {
      if(token.data !== '}') {
        return unexpected({
            message: 'expected `}`, got ' + token.data
          , expected: '}'
        })
      }
      state[0].brace = false
      return tokens.shift(), state.shift()
    }
    switch(token.type) {
      case 'eof': return got_eof()
      case 'keyword':
        switch(token.data) {
          case 'for': return state.unshift(forstmt());
          case 'if': return state.unshift(ifstmt());
          case 'while': return state.unshift(whilestmt());
          case 'do': return state.unshift(dowhilestmt());
          case 'break': return state.fake(mknode(BREAK, token)), tokens.shift()
          case 'continue': return state.fake(mknode(CONTINUE, token)), tokens.shift()
          case 'discard': return state.fake(mknode(DISCARD, token)), tokens.shift()
          case 'return': return state.unshift(returnstmt());
          case 'precision': return state.unshift(precision());
        }
        return state.unshift(decl(DECL_STATEMENT))
      case 'ident':
        var lookup
        if(lookup = state.scope.find(token.data)) {
          if(lookup.parent.type === 'struct') {
            // this is strictly untrue, you could have an
            // expr that starts with a struct constructor.
            //      ... sigh
            return state.unshift(decl(DECL_STATEMENT))
          }
          return state.unshift(expr(';'))
        }
      case 'operator':
        if(token.data === '{') {
          state[0].brace = true
          var n = stmtlist()
          n.expecting = '}'
          return tokens.shift(), state.unshift(n)
        }
        if(token.data === ';') {
          return tokens.shift(), state.shift()
        }
      default: return state.unshift(expr(';'))
    }
  }

  function got_eof() {
    ended = true

    // truncated input: every frame still open at end-of-file is an
    // unclosed construct. record one diagnostic for the innermost one
    // and unwind the whole stack, otherwise the same eof token would
    // be re-dispatched forever.
    if(state.length > 1) {
      var openFrame = state[0]
      try {
        unexpected({
            message: 'unexpected EOF'
          , locToken: openFrame && openFrame.token
          , expected: openFrame && openFrame.expecting
        })
      } catch(err) {
        if(!(err instanceof ParseSignal)) throw err
      }
      while(state.length > 1) state.shift()
      node = state[0]
      errored = false
      tokens.length && tokens.shift()
      token = tokens[0]
      return
    }

    return state.shift()
  }

  function parse_decl() {
    var stmt = state[0]

    return stative(
      invariant_or_not,
      storage_or_not,
      parameter_or_not,
      precision_or_not,
      struct_or_type,
      maybe_name,
      maybe_lparen,     // lparen means we're a function
      is_decllist,
      done
    )()

    function invariant_or_not() {
      if(token.data === 'invariant') {
        if(stmt.flags & DECL_ALLOW_INVARIANT) {
          state.unshift(keyword())
          return Advance
        } else {
          return unexpected('`invariant` is not allowed here')
        }
      } else {
        state.fake(mknode(PLACEHOLDER, {data: '', position: token.position}))
        return Advance
      }
    }

    function storage_or_not() {
      if(is_storage(token)) {
        if(stmt.flags & DECL_ALLOW_STORAGE) {
          state.unshift(keyword())
          return Advance
        } else {
          return unexpected('storage is not allowed here')
        }
      } else {
        state.fake(mknode(PLACEHOLDER, {data: '', position: token.position}))
        return Advance
      }
    }

    function parameter_or_not() {
      if(is_parameter(token)) {
        if(!(stmt.flags & DECL_NO_INOUT)) {
          state.unshift(keyword())
          return Advance
        } else {
          return unexpected('parameter is not allowed here')
        }
      } else {
        state.fake(mknode(PLACEHOLDER, {data: '', position: token.position}))
        return Advance
      }
    }

    function precision_or_not() {
      if(is_precision(token)) {
        state.unshift(keyword())
        return Advance
      } else {
        state.fake(mknode(PLACEHOLDER, {data: '', position: token.position}))
        return Advance
      }
    }

    function struct_or_type() {
      if(token.data === 'struct') {
        if(!(stmt.flags & DECL_ALLOW_STRUCT)) {
          return unexpected('cannot nest structs')
        }
        state.unshift(struct())
        return Advance
      }

      if(token.type === 'keyword') {
        state.unshift(keyword())
        return Advance
      }

      var lookup = state.scope.find(token.data)

      if(lookup) {
        state.fake(Object.create(lookup))
        tokens.shift()
        return Advance
      }
      return unexpected({
          message: 'expected user defined type, struct or keyword, got ' + token.data
        , expected: ['user-defined-type', 'struct', 'keyword']
      })
    }

    function maybe_name() {
      if(token.data === ',' && !(stmt.flags & DECL_ALLOW_COMMA)) {
        return state.shift()
      }

      if(token.data === '[') {
        // oh lord.
        state.unshift(quantifier())
        return
      }

      if(token.data === ')') return state.shift()

      if(token.data === ';') {
        return stmt.stage + 3
      }

      if(token.type !== 'ident' && token.type !== 'builtin') {
        return unexpected({
            message: 'expected identifier, got ' + token.data
          , expected: 'ident'
        })
      }

      stmt.collected_name = tokens.shift()
      return Advance
    }

    function maybe_lparen() {
      if(token.data === '(') {
        tokens.unshift(stmt.collected_name)
        delete stmt.collected_name
        state.unshift(fn())
        return stmt.stage + 2
      }
      return Advance
    }

    function is_decllist() {
      tokens.unshift(stmt.collected_name)
      delete stmt.collected_name
      state.unshift(decllist())
      return Advance
    }

    function done() {
      return state.shift()
    }
  }

  function parse_decllist() {
    // grab ident

    if(token.type === 'ident' || token.type === 'builtin') {
      var name = token.data
      state.unshift(ident())
      state.scope.define(name)
      return
    }

    if(token.type === 'operator') {

      if(token.data === ',') {
        // multi-decl!
        if(!(state[1].flags & DECL_ALLOW_COMMA)) {
          return state.shift()
        }

        return tokens.shift()
      } else if(token.data === '=') {
        if(!(state[1].flags & DECL_ALLOW_ASSIGN)) return unexpected('`=` is not allowed here.')

        tokens.shift()

        state.unshift(expr(',', ';'))
        return
      } else if(token.data === '[') {
        state.unshift(quantifier())
        return
      }
    }
    return state.shift()
  }

  function parse_keyword_or_ident() {
    if(token.type === 'keyword') {
      state[0].type = 'keyword'
      state[0].mode = KEYWORD
      return
    }

    if(token.type === 'ident') {
      state[0].type = 'ident'
      state[0].mode = IDENT
      return
    }

    return unexpected({
        message: 'expected keyword or user-defined name, got ' + token.data
      , expected: ['keyword', 'ident']
    })
  }

  function parse_keyword() {
    if(token.type !== 'keyword') {
      return unexpected({
          message: 'expected keyword, got ' + token.data
        , expected: 'keyword'
      })
    }

    return state.shift(), tokens.shift()
  }

  function parse_ident() {
    if(token.type !== 'ident' && token.type !== 'builtin') {
      return unexpected({
          message: 'expected user-defined name, got ' + token.data
        , expected: 'ident'
      })
    }

    state[0].data = token.data
    return state.shift(), tokens.shift()
  }


  function parse_expr() {
    var expecting = state[0].expecting

    state[0].tokens = state[0].tokens || []

    if(state[0].parenlevel === undefined) {
      state[0].parenlevel = 0
      state[0].bracelevel = 0
    }
    if(state[0].parenlevel < 1 && expecting.indexOf(token.data) > -1) {
      if(!state[0].tokens.length) {
        // e.g. `x = ;` -- an expression was required but none given.
        // for-loop clauses are explicitly optional, so those pass.
        if(state[0].optional) return state.shift()
        return unexpected({
            message: 'expected an expression, got `' + token.data + '`'
          , expected: 'expression'
          , locToken: token
        })
      }
      return parseexpr(state[0].tokens)
    }
    if(token.data === '(') {
      ++state[0].parenlevel
    } else if(token.data === ')') {
      --state[0].parenlevel
    }

    switch(token.data) {
      case '{': ++state[0].bracelevel; break
      case '}': --state[0].bracelevel; break
      case '(': ++state[0].parenlevel; break
      case ')': --state[0].parenlevel; break
    }

    if(state[0].parenlevel < 0) return unexpected({message: 'unexpected `)`', expected: '('})
    if(state[0].bracelevel < 0) return unexpected({message: 'unexpected `}`', expected: '{'})

    state[0].tokens.push(tokens.shift())
    return

    function parseexpr(tokens) {
      try {
        full_parse_expr(state, tokens)
      } catch(err) {
        if(err instanceof ParseSignal) throw err
        throw err
      }

      return state.shift()
    }
  }

  // node types ---------------

  function n(type) {
    // this is a function factory that suffices for most kinds of expressions and statements
    return function() {
      return mknode(type, token)
    }
  }

  function adhoc() {
    var node = mknode(token_map[token.type], token)
    if(token.type === 'preprocessor') {
      var parsed = parse_preprocessor_directive(token.data)
      node.directive = parsed.name
      if(parsed.name) node.argument = parsed.rest
      // directive line end: consume the trailing newline if present
      if(node.loc && typeof token.data === 'string') {
        var lines = token.data.split('\n')
        var lastLine = lines[lines.length - 1]
        node.loc.end = {
            line: token.line + lines.length - 1
          , column: lines.length === 1
            ? token.column + 1
            : lastLine.length + 1
          , position: token.position + token.data.length
        }
      }
    }
    return node
  }

  function decl(flags) {
    var _ = mknode(DECL, token, node)
    _.flags = flags

    return _
  }

  function struct(allow_assign, allow_comma) {
    var _ = mknode(STRUCT, token, node)
    _.allow_assign = allow_assign === undefined ? true : allow_assign
    _.allow_comma = allow_comma === undefined ? true : allow_comma
    return _
  }

  function expr() {
    var n = mknode(EXPR, token, node)

    n.expecting = [].slice.call(arguments)
    return n
  }

  // expression node for optional for-loop clauses: an empty token list
  // terminating on `;` or `)` is legal here
  function optionalExpr() {
    var n = expr.apply(null, arguments)
    n.optional = true
    return n
  }

  function keyword(default_value) {
    var t = token
    if(default_value) {
      t = {'type': '(implied)', data: '(default)', position: t.position}
    }
    return mknode(KEYWORD, t, node)
  }

  // utils ----------------------------

  // record a syntax diagnostic and unwind via ParseSignal. accepts
  // either a plain message string or an options object with an
  // explicit `expected` token description and source locToken.
  function unexpected(str) {
    var opts = typeof str === 'string' ? { message: str } : (str || {})
    var ref = opts.locToken || token || (state[0] && state[0].token) || {}

    var diag = {
        type: 'error'
      , source: 'parser'
      , message: opts.message || 'unexpected token'
    }

    if(typeof ref.line === 'number') {
      // tokenizer `column` is the 0-based offset of the token's last
      // character; report the 1-based start column for consistency
      // with node.loc.
      var startColumn = typeof ref.data === 'string'
        ? ref.column - ref.data.length + 1
        : ref.column
      diag.line = ref.line
      diag.column = startColumn
      diag.position = ref.position
      diag.loc = {
          start: { line: ref.line, column: startColumn, position: ref.position }
      }
      if(typeof ref.data === 'string') {
        diag.loc.end = {
            line: ref.line
          , column: ref.column + 1
          , position: ref.position + ref.data.length
        }
      }
    }

    if(opts.expected !== undefined) {
      diag.expected = opts.expected
    } else if(state[0] && state[0].expecting !== undefined) {
      diag.expected = state[0].expecting
    }

    if(opts.actual) {
      diag.actual = opts.actual
    } else if(ref && ref.type) {
      diag.actual = { type: ref.type, data: ref.data }
    }

    // avoid duplicate diagnostics for the same token while recovering
    var last = diagnostics[diagnostics.length - 1]
    var duplicate = last &&
      last.message === diag.message &&
      last.position === diag.position

    if(!duplicate) diagnostics.push(diag)

    errored = true
    throw new ParseSignal(diag)
  }

  function assert(type, data) {
    return assert_null_string_or_array(type, token.type) &&
      assert_null_string_or_array(data, token.data)
  }

  function assert_null_string_or_array(x, y) {
    switch(typeof x) {
      case 'string': if(y !== x) {
        unexpected({
            message: 'expected `' + x + '`, got ' + y
          , expected: x
        })
      } return !errored

      case 'object': if(x && x.indexOf(y) === -1) {
        unexpected({
            message: 'expected one of `' + x.join('`, `') + '`, got ' + y
          , expected: x
        })
      } return !errored
    }
    return true
  }

  // stative ----------------------------

  function stative() {
    var steps = [].slice.call(arguments)
      , step
      , result

    return function() {
      var current = state[0]

      current.stage || (current.stage = 0)

      step = steps[current.stage]
      if(!step) return unexpected('parser in undefined state!')

      result = step()

      if(result === Advance) return ++current.stage
      if(result === undefined) return
      current.stage = result
    }
  }

  function advance(op, t) {
    t = t || 'operator'
    return function() {
      if(!assert(t, op)) return

      var last = tokens.shift()
        , children = state[0].children
        , last_node = children[children.length - 1]

      if(last_node && last_node.token && last.preceding) {
        last_node.token.succeeding = last_node.token.succeeding || []
        last_node.token.succeeding = last_node.token.succeeding.concat(last.preceding)
      }
      return Advance
    }
  }

  function advance_expr(until) {
    return function() {
      state.unshift(expr(until))
      return Advance
    }
  }

  function advance_optional_expr(until) {
    return function() {
      state.unshift(optionalExpr(until))
      return Advance
    }
  }

  function advance_ident(declare) {
    return declare ? function() {
      var name = token.data
      return assert('ident') && (state.unshift(ident()), state.scope.define(name), Advance)
    } :  function() {
      if(!assert('ident')) return

      var s = Object.create(state.scope.find(token.data))
      s.token = token

      return (tokens.shift(), Advance)
    }
  }

  function advance_stmtlist() {
    return function() {
      var n = stmtlist()
      n.expecting = '}'
      return state.unshift(n), Advance
    }
  }

  function maybe_stmtlist(skip) {
    return function() {
      var current = state[0].stage
      if(token.data !== '{') { return state.unshift(stmt()), current + skip }
      return tokens.shift(), Advance
    }
  }

  function popstmt() {
    return function() { return state.shift(), state.shift() }
  }


  function setup_stative_parsers() {

    // could also be
    // struct { } decllist
    parse_struct =
        stative(
          advance('struct', 'keyword')
        , function() {
            if(token.data === '{') {
              state.fake(mknode(IDENT, {data:'', position: token.position, type:'ident'}))
              return Advance
            }

            return advance_ident(true)()
          }
        , function() { state.scope.enter(); return Advance }
        , advance('{')
        , function() {
            if(token.type === 'preprocessor') {
              state.fake(adhoc())
              tokens.shift()
              return
            }
            if(token.data === '}') {
              state.scope.exit()
              tokens.shift()
              return state.shift()
            }
            if(token.data === ';') { tokens.shift(); return }
            state.unshift(decl(DECL_STRUCT))
          }
        )

    parse_precision =
        stative(
          function() { return tokens.shift(), Advance }
        , function() {
            return assert(
            'keyword', ['lowp', 'mediump', 'highp']
            ) && (state.unshift(keyword()), Advance)
          }
        , function() { return (state.unshift(keyword()), Advance) }
        , function() { return state.shift() }
        )

    parse_quantifier =
        stative(
          advance('[')
        , advance_expr(']')
        , advance(']')
        , function() { return state.shift() }
        )

    parse_forloop =
        stative(
          advance('for', 'keyword')
        , advance('(')
        , function() {
            var lookup
            if(token.type === 'ident') {
              if(!(lookup = state.scope.find(token.data))) {
                lookup = state.create_node()
              }

              if(lookup.parent.type === 'struct') {
                return state.unshift(decl(DECL_STATEMENT)), Advance
              }
            } else if(token.type === 'builtin' || token.type === 'keyword') {
              return state.unshift(decl(DECL_STATEMENT)), Advance
            }
            return advance_optional_expr(';')()
          }
        , advance(';')
        , advance_optional_expr(';')
        , advance(';')
        , advance_optional_expr(')')
        , advance(')')
        , maybe_stmtlist(3)
        , advance_stmtlist()
        , advance('}')
        , popstmt()
        )

    parse_if =
        stative(
          advance('if', 'keyword')
        , advance('(')
        , advance_expr(')')
        , advance(')')
        , maybe_stmtlist(3)
        , advance_stmtlist()
        , advance('}')
        , function() {
            if(token.data === 'else') {
              return tokens.shift(), state.unshift(stmt()), Advance
            }
            return popstmt()()
          }
        , popstmt()
        )

    parse_return =
        stative(
          advance('return', 'keyword')
        , function() {
            if(token.data === ';') return Advance
            return state.unshift(expr(';')), Advance
          }
        , function() { tokens.shift(), popstmt()() }
        )

    parse_whileloop =
        stative(
          advance('while', 'keyword')
        , advance('(')
        , advance_expr(')')
        , advance(')')
        , maybe_stmtlist(3)
        , advance_stmtlist()
        , advance('}')
        , popstmt()
        )

    parse_dowhileloop =
      stative(
        advance('do', 'keyword')
      , maybe_stmtlist(3)
      , advance_stmtlist()
      , advance('}')
      , advance('while', 'keyword')
      , advance('(')
      , advance_expr(')')
      , advance(')')
      , popstmt()
      )

    parse_function =
      stative(
        function() {
          for(var i = 1, len = state.length; i < len; ++i) if(state[i].mode === FUNCTION) {
            return unexpected('function definition is not allowed within another function')
          }

          return Advance
        }
      , function() {
          if(!assert("ident")) return

          var name = token.data
            , lookup = state.scope.find(name)

          state.unshift(ident())
          state.scope.define(name)

          state.scope.enter(lookup ? lookup.scope : null)
          return Advance
        }
      , advance('(')
      , function() { return state.unshift(fnargs()), Advance }
      , advance(')')
      , function() {
          // forward decl
          if(token.data === ';') {
            return state.scope.exit(), state.shift(), state.shift()
          }
          return Advance
        }
      , advance('{')
      , advance_stmtlist()
      , advance('}')
      , function() { state.scope.exit(); return Advance }
      , function() { return state.shift(), state.shift(), state.shift() }
      )

    parse_function_args =
      stative(
        function() {
          if(token.data === 'void') { state.fake(keyword()); tokens.shift(); return Advance }
          if(token.data === ')') { state.shift(); return }
          if(token.data === 'struct') {
            state.unshift(struct(NO_ASSIGN_ALLOWED, NO_COMMA_ALLOWED))
            return Advance
          }
          state.unshift(decl(DECL_FUNCTION))
          return Advance
        }
      , function() {
          if(token.data === ',') { tokens.shift(); return 0 }
          if(token.data === ')') { state.shift(); return }
          unexpected({
              message: 'expected one of `,` or `)`, got ' + token.data
            , expected: [',', ')']
          })
        }
      )
  }
}

function mknode(mode, sourcetoken) {
  var node = {
      mode: mode
    , token: sourcetoken
    , children: []
    , type: stmt_type[mode]
    , id: (Math.random() * 0xFFFFFFFF).toString(16)
  }
  if(sourcetoken && typeof sourcetoken.line === 'number') {
    // the tokenizer reports `column` as the 0-based offset of the
    // token's final character; convert it to a 1-based start column so
    // loc.start.column points at the first character of the token.
    var startColumn = typeof sourcetoken.data === 'string'
      ? sourcetoken.column - sourcetoken.data.length + 1
      : sourcetoken.column
    node.loc = {
        start: {
            line: sourcetoken.line
          , column: startColumn
          , position: sourcetoken.position
        }
    }
    if(typeof sourcetoken.data === 'string') {
      node.loc.end = {
          line: sourcetoken.line
        , column: sourcetoken.column + 1
        , position: sourcetoken.position + sourcetoken.data.length
      }
    }
  }
  return node
}

// split a raw preprocessor token text into its directive name and the
// remaining payload, collapsing backslash-newline line continuations.
function parse_preprocessor_directive(data) {
  var flat = String(data).replace(/\\\r?\n/g, ' ')
  var match = /^[ \t]*#[ \t]*([A-Za-z_]\w*)?/.exec(flat)
  if(!match) return { name: null, rest: '' }
  return {
      name: match[1] || null
    , rest: flat.slice(match[0].length).replace(/^[ \t]+/, '').replace(/[ \t]+$/, '')
  }
}

function is_storage(token) {
  return token.data === 'const' ||
         token.data === 'attribute' ||
         token.data === 'uniform' ||
         token.data === 'varying'
}

function is_parameter(token) {
  return token.data === 'in' ||
         token.data === 'inout' ||
         token.data === 'out'
}

function is_precision(token) {
  return token.data === 'highp' ||
         token.data === 'mediump' ||
         token.data === 'lowp'
}
