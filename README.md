# glsl-parser

![](http://img.shields.io/badge/stability-stable-green.svg?style=flat)
![](http://img.shields.io/npm/v/glsl-parser.svg?style=flat)
![](http://img.shields.io/npm/dm/glsl-parser.svg?style=flat)
![](http://img.shields.io/npm/l/glsl-parser.svg?style=flat)

A GLSL parser that takes tokens from
[glsl-tokenizer](http://github.com/stackgl/glsl-tokenizer) and turns them into
an AST.

May either be used synchronously or as a stream.

## API

### `stream = require('glsl-parser/stream')`

Creates a GLSL parser stream, which emits nodes as they're parsed.

``` javascript
var TokenStream = require('glsl-tokenizer/stream')
var ParseStream = require('glsl-parser/stream')
var fs = require('fs')

fs.createReadStream('test.glsl')
  .pipe(TokenStream())
  .pipe(ParseStream())
  .on('data', function(x) {
    console.log('ast of', x.type)
  })
```

### `ast = stream.program`

The full program's AST, which will be updated with each incoming token.

### `ast = require('glsl-parser/direct')(tokens)`

Synchronously parses an array of tokens from `glsl-tokenizer`.

``` javascript
var TokenString = require('glsl-tokenizer/string')
var ParseTokens = require('glsl-parser/direct')
var fs = require('fs')

var src = fs.readFileSync('test.glsl', 'utf8')
var tokens = TokenString(src)
var ast = ParseTokens(tokens)

console.log(ast)
```

## Nodes

* `stmtlist`
* `stmt`
* `struct`
* `function`
* `functionargs`
* `decl`
* `decllist`
* `forloop`
* `whileloop`
* `if`
* `expr`
* `precision`
* `comment`
* `preprocessor`
* `keyword`
* `ident`
* `return`
* `continue`
* `break`
* `discard`
* `do-while`
* `binary`
* `ternary`
* `unary`

Every node built from a source token carries a `loc` range with 1-based
columns:

``` javascript
node.loc = {
    start: { line, column, position }
  , end:   { line, column, position }
}
```

### Preprocessing

Tokens are run through a built-in preprocessor before parsing, so the
public API is unchanged:

* object-like (`#define A 1`) and function-like (`#define F(x) ...`)
  macros are expanded, including nested invocations and line-continued
  definitions. Expanded tokens keep the **invocation site's**
  line/column (and gain a `macroExpansion` naming the macro), while
  substituted argument tokens keep their own original source location.
  Self- and mutually recursive macros are guarded against infinite
  expansion.
* `#ifdef` / `#ifndef` / `#if` / `#elif` / `#else` / `#endif` select
  branches according to the active macro definitions, including
  `defined(...)` and constant expressions. Tokens in skipped branches
  never reach the AST. `#define` and `#undef` are honored accordingly.
* directive tokens (`#version`, `#extension`, `#line`, ...) remain in
  the AST as `preprocessor` nodes and additionally expose:
  * `node.directive` — the directive name, e.g. `"version"`
  * `node.argument`  — the remainder of the line
  * `node.loc`       — the directive's source range

### Diagnostics

Syntax errors no longer throw. They are collected on the program node
(and, for streams, on `stream.program`):

``` javascript
var ast = require('glsl-parser/direct')(tokens)
ast.diagnostics.forEach(function(d) {
  // d.type      'error'
  // d.source    'parser' | 'preprocessor'
  // d.message
  // d.line, d.column, d.position   (1-based column)
  // d.loc       { start, end }
  // d.expected  token description, when known
  // d.actual    { type, data } of the offending token
})
```

The parser resynchronizes at the next statement boundary, so a single
parse can report several independent errors while retaining the valid
declarations around them.

## Known Issues

* because i am not smart enough to write a fully streaming parser, the current parser "cheats" a bit when it encounters a `expr` node! it actually waits until it has all the tokens it needs to build a tree for a given expression, then builds it and emits the constituent child nodes in the expected order. the `expr` parsing is heavily influenced by [crockford's tdop article](http://javascript.crockford.com/tdop/tdop.html). the rest of the parser is heavily influenced by fever dreams.

* the parser might hit a state where it's looking at what *could be* an expression, or it could be a declaration --
that is, the statement starts with a previously declared `struct`. it'll opt to pretend it's a declaration, but that
might not be the case -- it might be a user-defined constructor starting a statement!

* `#if` / `#endif` blocks that split a single syntactic construct across
branches are still not supported: place conditionals at statement level
so each branch is independently parseable.

## License

MIT, see [LICENSE.md](LICENSE.md) for more details.
