var test = require('tape')
var path = require('path')
var fs   = require('fs')

var TokenStream = require('glsl-tokenizer/stream')
var TokenString = require('glsl-tokenizer/string')
var ParseStream = require('../stream')
var ParseArray  = require('../direct')
var Preprocessor = require('../lib/preprocessor')

function parse(src) {
  return ParseArray(TokenString(src))
}

// ------------------------------------------------------------------
// object-like and function-like macro expansion
// ------------------------------------------------------------------

test('preprocessor: object-like macro expansion', function(t) {
  var ast = parse([
    '#define PI 3.14',
    'float x = PI;'
  ].join('\n'))

  t.deepEqual(ast.diagnostics, [], 'no diagnostics')

  var literal = findNode(ast, function(n) {
    return n.type === 'literal' && n.token.data === '3.14'
  })
  t.ok(literal, 'macro body appears in the AST')
  t.equal(literal.token.line, 2, 'expanded token keeps invocation line')
  t.equal(literal.token.column, 12, 'expanded token keeps invocation column')
  t.equal(literal.token.macroExpansion, 'PI', 'token records its origin macro')
  t.end()
})

test('preprocessor: function-like macro expansion', function(t) {
  var ast = parse([
    '#define ADD(a, b) ((a) + (b))',
    'float y = ADD(1, 2);'
  ].join('\n'))

  t.deepEqual(ast.diagnostics, [], 'no diagnostics')

  var stamped = collectTokens(ast).filter(function(tok) {
    return tok.macroExpansion === 'ADD'
  })
  t.ok(stamped.length >= 3, 'operator/paren tokens are stamped')
  stamped.forEach(function(tok) {
    t.equal(tok.line, 2, 'stamped line is the invocation line')
    t.equal(tok.column, 13, 'stamped column is the invocation column')
  })

  // argument tokens keep their own original source location
  var argOne = findNode(ast, function(n) {
    return n.type === 'literal' && n.token.data === '1'
  })
  t.equal(argOne.token.line, 2)
  t.equal(argOne.token.column, 15, 'argument token retains original column')
  t.notOk(argOne.token.macroExpansion, 'argument token is not stamped')
  t.end()
})

test('preprocessor: nested function macro invocations', function(t) {
  var ast = parse([
    '#define ADD(a,b) ((a)+(b))',
    'int x = ADD(ADD(1,2), 3);'
  ].join('\n'))

  t.deepEqual(ast.diagnostics, [], 'no diagnostics')
  var inner = collectTokens(ast).filter(function(tok) {
    return tok.macroExpansion === 'ADD' && tok.column === 15
  })
  var outer = collectTokens(ast).filter(function(tok) {
    return tok.macroExpansion === 'ADD' && tok.column === 11
  })
  t.ok(inner.length, 'inner invocation stamped at inner call site')
  t.ok(outer.length, 'outer invocation stamped at outer call site')
  t.end()
})

test('preprocessor: recursive macros terminate', function(t) {
  var ast = parse('#define A (A + 1)\nint x = A;')
  t.deepEqual(ast.diagnostics, [], 'self reference does not loop or error')

  var mutual = parse('#define A B\n#define B A\nint x = A;')
  t.deepEqual(mutual.diagnostics, [], 'mutual reference does not loop or error')
  t.end()
})

test('preprocessor: line continuations in definitions', function(t) {
  var ast = parse('#define LONG(a) \\\n  (a + 1)\nint x = LONG(42);')
  t.deepEqual(ast.diagnostics, [], 'no diagnostics')
  var stamped = collectTokens(ast).filter(function(tok) {
    return tok.macroExpansion === 'LONG'
  })
  t.ok(stamped.length, 'macro spanning lines still expands')
  stamped.forEach(function(tok) {
    t.equal(tok.line, 3, 'expansion points at invocation, not definition')
  })
  t.end()
})

test('preprocessor: empty object macro removes the identifier', function(t) {
  var ast = parse('#define EMPTY\nint x = EMPTY 1;')
  t.deepEqual(ast.diagnostics, [], 'no diagnostics')
  var idents = collectTokens(ast).filter(function(tok) { return tok.data === 'EMPTY' })
  t.equal(idents.length, 0, 'EMPTY identifier disappears from the token stream')
  t.end()
})

test('preprocessor: function macro without invocation stays an identifier', function(t) {
  var ast = parse('#define F(x) x\nint F = 1;')
  t.deepEqual(ast.diagnostics, [], 'no diagnostics')
  var f = collectTokens(ast).filter(function(tok) { return tok.data === 'F' })
  t.equal(f.length, 1, 'bare F is emitted untouched')
  t.notOk(f[0].macroExpansion)
  t.end()
})

test('preprocessor: arity mismatch is diagnosed but does not throw', function(t) {
  var ast = parse('#define F(a,b) a+b\nint x = F(1);')
  t.equal(ast.diagnostics.length, 1)
  t.equal(ast.diagnostics[0].source, 'preprocessor')
  t.ok(/expects 2 argument/.test(ast.diagnostics[0].message))
  t.end()
})

test('preprocessor: #undef removes a macro', function(t) {
  var ast = parse('#define A 1\n#undef A\nint x = A;')
  t.deepEqual(ast.diagnostics, [], 'no diagnostics')
  var a = collectTokens(ast).filter(function(tok) { return tok.data === 'A' })
  t.equal(a.length, 1, 'A survives as a plain identifier after undef')
  t.notOk(a[0].macroExpansion)
  t.end()
})

// ------------------------------------------------------------------
// conditional inclusion
// ------------------------------------------------------------------

test('preprocessor: #ifdef / #ifndef / #else / #endif branches', function(t) {
  var ast = parse([
    '#define FOO 1',
    '#ifdef FOO',
    'float a = 1.0;',
    '#else',
    'float a = 2.0;',
    '#endif',
    '#ifndef BAR',
    'float b = 3.0;',
    '#endif'
  ].join('\n'))

  t.deepEqual(ast.diagnostics, [], 'no diagnostics')
  t.ok(hasLiteral(ast, '1.0'), 'ifdef true branch kept')
  t.notOk(hasLiteral(ast, '2.0'), 'ifdef false branch dropped')
  t.ok(hasLiteral(ast, '3.0'), 'ifndef true branch kept')
  t.end()
})

test('preprocessor: #if / #elif / #else with constant expressions', function(t) {
  var ast = parse([
    '#define N 2',
    '#if N > 2',
    'float c = 4.0;',
    '#elif N == 2',
    'float c = 5.0;',
    '#else',
    'float c = 6.0;',
    '#endif'
  ].join('\n'))

  t.deepEqual(ast.diagnostics, [], 'no diagnostics')
  t.notOk(hasLiteral(ast, '4.0'))
  t.ok(hasLiteral(ast, '5.0'), 'elif branch selected')
  t.notOk(hasLiteral(ast, '6.0'))
  t.end()
})

test('preprocessor: defined() operator in #if', function(t) {
  var ast = parse([
    '#define FOO 1',
    '#if defined(FOO) && !defined(BAR)',
    'int a = 1;',
    '#endif'
  ].join('\n'))
  t.deepEqual(ast.diagnostics, [], 'no diagnostics')
  t.ok(hasLiteral(ast, '1'), 'defined() expression evaluates correctly')

  var skipped = parse([
    '#if defined(NOPE)',
    'int b = 2;',
    '#endif'
  ].join('\n'))
  t.notOk(hasLiteral(skipped, '2'), 'false defined() branch is skipped')
  t.end()
})

test('preprocessor: unmatched conditionals are diagnosed', function(t) {
  var pp = new Preprocessor()
  pp.process(TokenString('#if 1\nint a = 1;\n'))
  pp.end()
  t.equal(pp.diagnostics.length, 1)
  t.ok(/#endif/.test(pp.diagnostics[0].message))
  t.end()
})

// ------------------------------------------------------------------
// directive node locations
// ------------------------------------------------------------------

test('ast: #version and #extension nodes carry locations and directive info', function(t) {
  var ast = parse([
    '#version 300 es',
    '#extension GL_OES_standard_derivatives : enable',
    'void main() { int z = 1; }'
  ].join('\n'))

  t.deepEqual(ast.diagnostics, [], 'no diagnostics')

  var directives = []
  ;(function walk(n) {
    if(!n) return
    if(n.type === 'preprocessor') directives.push(n)
    ;(n.children || []).forEach(walk)
  })(ast)

  t.equal(directives.length, 2)
  t.equal(directives[0].directive, 'version')
  t.equal(directives[0].argument, '300 es')
  t.equal(directives[0].loc.start.line, 1)
  t.equal(directives[0].loc.start.column, 1, 'start column is 1-based at first char')
  t.ok(directives[0].loc.end.position > directives[0].loc.start.position)

  t.equal(directives[1].directive, 'extension')
  t.equal(directives[1].loc.start.line, 2)
  t.ok(/GL_OES_standard_derivatives/.test(directives[1].argument))
  t.end()
})

test('ast: ordinary nodes carry loc with line and column', function(t) {
  var ast = parse('float x = 1.0;')
  var decl = findNode(ast, function(n) { return n.type === 'decl' })
  t.ok(decl.loc, 'decl has loc')
  t.equal(decl.loc.start.line, 1)
  t.equal(decl.loc.start.column, 1, 'start column is 1-based')
  t.ok(decl.loc.end, 'loc has an end range')
  t.equal(decl.loc.end.column, 6, 'end column is exclusive (after float)')
  t.end()
})

test('ast: expression nodes carry loc pointing at their own token', function(t) {
  var ast = parse('float x = 1.0 + 2.0;')
  var binary = findNode(ast, function(n) { return n.type === 'binary' })
  t.ok(binary, 'binary expression node exists')
  t.ok(binary.loc, 'expression node has loc even though it is built in expr.js')
  t.equal(binary.loc.start.line, 1)
  t.equal(binary.token.data, '+')
  t.equal(binary.loc.start.column, 15, 'loc points at the operator, 1-based')

  // macro-expanded expression nodes: loc follows the stamped invocation
  var expanded = parse('#define M(a) (a)\nfloat y = M(1.0) + 2.0;')
  t.deepEqual(expanded.diagnostics, [], 'no diagnostics')
  var stampedNode = findNode(expanded, function(n) {
    return n.token && n.token.macroExpansion === 'M' && n.loc
  })
  t.ok(stampedNode, 'macro-expanded expression node has loc')
  t.equal(stampedNode.loc.start.line, 2, 'loc line is the invocation line')
  t.end()
})

// ------------------------------------------------------------------
// diagnostics / error recovery
// ------------------------------------------------------------------

test('parser: syntax errors are collected as diagnostics, not thrown', function(t) {
  var ast
  t.doesNotThrow(function() {
    ast = parse('int y = @;\nfloat z = 1.0;')
  })

  t.equal(ast.diagnostics.length, 1)
  var d = ast.diagnostics[0]
  t.equal(d.source, 'parser')
  t.equal(d.line, 1, 'line points at the bad token')
  t.equal(d.column, 9, 'column points at the bad token')
  t.deepEqual(d.actual, { type: 'operator', data: '@' }, 'actual token included')
  t.ok(d.expected, 'expected token included')

  // parsing continued: the later valid declaration is still present
  t.ok(findNode(ast, function(n) {
    return n.type === 'ident' && n.token.data === 'z'
  }), 'subsequent valid statements still parsed')
  t.end()
})

test('parser: multiple errors are reported in one pass', function(t) {
  var ast = parse([
    'float x = ;',
    'int y = @;',
    'void main() {',
    '  1 + ;',
    '  float ok = 2.0;',
    '}'
  ].join('\n'))

  t.ok(ast.diagnostics.length >= 2, 'at least two diagnostics (' + ast.diagnostics.length + ' found)')
  var lines = ast.diagnostics.map(function(d) { return d.line })
  t.ok(lines.indexOf(2) !== -1, 'error on line 2 reported')
  t.ok(lines.indexOf(4) !== -1, 'error on line 4 reported')

  ast.diagnostics.forEach(function(d) {
    t.equal(typeof d.line, 'number')
    t.equal(typeof d.column, 'number')
    t.ok(d.actual, 'each diagnostic has an actual token')
    t.ok(d.message)
  })

  t.ok(findNode(ast, function(n) {
    return n.type === 'ident' && n.token.data === 'ok'
  }), 'valid declaration between errors is retained')
  t.end()
})

test('parser: unexpected EOF is a diagnostic, not a throw', function(t) {
  var ast
  t.doesNotThrow(function() {
    ast = parse('void main() { float x = 1.0;')
  })
  t.equal(ast.diagnostics.length, 1)
  t.ok(/EOF/.test(ast.diagnostics[0].message))
  t.end()
})

// ------------------------------------------------------------------
// stream parity
// ------------------------------------------------------------------

test('stream: preprocessing and diagnostics match the sync path', function(t) {
  var src = [
    '#define MUL(a, b) (a * b)',
    '#define ON 1',
    '#if ON',
    'float a = MUL(2, 3);',
    '#endif',
    'void main() { float x = ; float y = 1.0; }'
  ].join('\n')

  var syncAST = ParseArray(TokenString(src))

  var tokenStream = TokenStream()
  var parseStream = ParseStream()
  tokenStream.pipe(parseStream)
  parseStream.on('data', function() {})
  parseStream.on('end', function() {
    t.deepEqual(
      selectors(parseStream.program),
      selectors(syncAST),
      'stream and sync produce identical node selector chains'
    )
    t.deepEqual(parseStream.program.diagnostics, syncAST.diagnostics,
      'stream and sync produce identical diagnostics')
    t.end()
  })
  tokenStream.end(src)
})

// ------------------------------------------------------------------
// helpers
// ------------------------------------------------------------------

function findNode(node, pred) {
  if(!node) return null
  if(pred(node)) return node
  var children = node.children || []
  for(var i = 0; i < children.length; i++) {
    var hit = findNode(children[i], pred)
    if(hit) return hit
  }
  return null
}

function collectTokens(node, acc) {
  acc = acc || []
  if(node && node.token) acc.push(node.token)
  ;(node && node.children || []).forEach(function(c) {
    collectTokens(c, acc)
  })
  return acc
}

function hasLiteral(ast, value) {
  return !!findNode(ast, function(n) {
    return n.type === 'literal' && n.token && n.token.data === value
  })
}

function selectors(ast) {
  var out = []
  ;(function walk(x) {
    if(!x || !x.type) return
    var chain = [], n = x
    do { chain.unshift(n.type) } while(n = n.parent)
    out.push(chain)
    ;(x.children || []).forEach(walk)
  })(ast)
  return out
}
