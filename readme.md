## Overview

Posterus is a library of promise-like asynchronous primitives (futures) that
support true cancelation. Futures compose just like promises, but can also be
cleanly shut down, aborting pending operations and freeing resources.

Lightweight (around 6 KB minified), with solid performance.

## TOC

* [Overview](#overview)
* [TOC](#toc)
* [Why](#why)
* [Installation](#installation)
* [TL:DR API](#tldr-api)
* [API](#api)
   * [`Future`](#future)
      * [`future.arrive`](#futurearriveerror-result)
      * [`future.map`](#futuremapmapper)
      * [`future.mapError`](#futuremaperrormapper)
      * [`future.mapResult`](#futuremapresultresult)
      * [`future.toPromise`](#futuretopromise)
      * [`future.catch`](#futurecatchonrejected)
      * [`future.then`](#futurethenonresolved)
      * [`future.finishPending`](#futurefinishpending)
      * [`future.deref`](#futurederef)
      * [`future.deinit`](#futuredeinit)
   * [Statics](#statics)
      * [`Future.init`](#futureinitiniter)
      * [`Future.initAsync`](#futureinitasynciniter)
      * [`Future.from`](#futurefromerror-result)
      * [`Future.fromError`](#futurefromerrorerror)
      * [`Future.fromResult`](#futurefromresultresult)
      * [`Future.all`](#futureallvalues)
      * [`Future.race`](#futureracevalues)
      * [`Future.handleRejection`](#futurehandlerejectionfuture)
   * [`isFuture`](#isfuturevalue)
* [Misc](#misc)

## Why

### Why not standard promises?

Cancelation! It's missing from the JS Promise spec, and it's a BIG deal, far
bigger than most developers realise. The ability to stop async operations,
completely freeing resources and memory, has massive benefits that may be
difficult to notice until you have it.

### Why not add cancelation support to promises?

People have tried, with unsatisfactory results. The Promise design is
fundamentally incompatible with cancelation due to its one-to-many model: each
promise may have multiple consumers (child promise callbacks), and therefore
none can claim exclusive control over its lifecycle. Posterus avoids this by
sticking to _exclusive ownership_: one consumer per instance.

Here's an example: in Bluebird, cancelation doesn't propagate upstream. After
registering `onCancel` in a promise constructor, you have to call `.cancel()` on
that exact promise object. Calling `.cancel()` in any child promise created with
`.then()` or `.catch()` will not abort the work, rendering the feature useless
for the most common use case!

True cancelation must propagate upstream, prevent all pending work, and
immediately free resources and memory.

## Installation

Install with NPM:

```sh
npm i -E posterus
# or
yarn add -E posterus
```

Then import:

```js
const {Future} = require('posterus')
```

## TL:DR API

Gist:

* create with [`Future.init`](#futureinitiniter),
  [`Future.from`](#futurefromerror-result),
  [`Future.fromResult`](#futurefromresultresult)

* transform with [`future.map`](#futuremapmapper),
  [`future.mapError`](#futuremaperrormapper),
  [`future.mapResult`](#futuremapresultresult)

* combine with [`Future.all`](#futureallvalues),
  [`Future.race`](#futureracevalues)

* cancel with [`future.deinit`](#futuredeinit)

```js
const {Future} = require('posterus')

const future = Future.init(future => {
  // maybe async work, then:
  future.arrive(Error('<async error>'), '<unused result>')
  return function onDeinit () {/* cancel async work here */}
})
.mapResult(result => Future.init(future => {
  // maybe async work, then:
  future.arrive(null, '<async result>')
  return function onDeinit () {/* cancel async work here */}
}))
.mapError(error => {
  console.warn(error)
  return '<replacement result>'
})
.map((error, result) => {
  console.info(error, result)
})

// this cancels the entire chain
// including nested async work that may or may not have started
future.deinit()

Future.all([
  '<plain>',
  Future.initAsync(future => {
    future.arrive(null, '<async>')
  }),
])
.mapResult(result => {
  console.info(result)  // ['<plain>', '<async>']
})

Future.race([
  Future.init(future => {
    return function onDeinit () {
      console.info('lost the race, canceling')
    }
  }),
  Future.fromResult('<this one wins the race>'),
])
```

## API

### `Future()`

Core constructor intended for lower-level use. Most of the time, you'll be using
[`Future.init`](#futureinitiniter) or
[`Future.initAsync`](#futureinitasynciniter), fully-fledged constructors with
support for initialiser function and cancelation.

Creates a pending future that can be finalised by calling
[`.arrive()`](#futurearriveerror-result) and/or canceled with
[`.deinit()`](#futuredeinit).

```js
const {Future} = require('future')

const future = new Future()

future.arrive(null, '<result>')

const derived = future.map((error, result) => {
  console.info(error, result)
})
.mapResult(result => {
  console.info(result)
})
.mapError(error => {
  console.warn(error)
})

// cancels entire chain
derived.deinit()
```

#### `future.arrive(error, result)`

Resolves the future with the provided error and result. Similar to
`Promise.reject` and `Promise.resolve`, combined into one "errback" signature.
Can be called at any point after creating the future.

The future is considered rejected if `error` is truthy, and successful
otherwise, like in a typical Node.js errback.

Just like `Promise.reject` and `Promise.resolve`, accepts other futures and
automatically "flattens", eventually resolving to a non-future.

If the future has previosly been resolved or deinited, this is a no-op.

If the future has been previously mapped over, `.arrive()` will propagate the
result to the child future.

```js
// Will warn about unhandled rejection
new Future().arrive(Error('<error>'))

new Future().arrive(null, '<result>')
  .mapResult(result => {
    console.info(result)  // '<result>'
  })

// flattens provided future
new Future().arrive(null, Future.fromResult('<future result>'))
  .mapResult(result => {
    console.info(result)  // '<future result>'
  })

// waits for provided future
new Future().arrive(null, Future.initAsync(future => future.arrive(null, '<async result>')))
  .mapResult(result => {
    console.info(result)  // '<async result>'
  })

// waits for provided future
new Future().arrive(Future.initAsync(future => future.arrive(Error('<async error>'))))
  .mapError(error => {
    console.warn(error)  // '<async error>'
  })
```

When called after `.map()`, propagates error and result to child future:

```js
const parent = new Future()

const child = parent.map((error, result) => {
  console.info(error, result)
})

parent.arrive(null, '<result>')
```

#### `future.map(mapper)`

where `mapper: ƒ(error, result): any`

Core chaining operation. Takes a "mapper" function and creates a future
representing the transformation of the eventual result of `future` by the
mapper. Compared to promises, this is like a combination of `.then()` and
`.catch()` into one function.

Just like [`.arrive()`](#futurearriveerror-result), this automatically
"flattens" the futures provided by the mapper, eventually resolving to
non-future values. This is known as "flatmap" in some languages.

The newly created future assumes control of the original future and any
intermediary futures, and will [`.deinit()`](#futuredeinit) them when canceled.

This operation "consumes" the future, disallowing any further chain calls on the
same reference. In other words, each future can only have _one consumer_ which
has _exclusive ownership_ over it. This allows for cancelation without
unexpected adversities.

All other chaining operations are defined in terms of `.map()` and share these
characteristics.

```js
Future.init(future => {
  // maybe async work, then:
  future.arrive(null, '<message>')
})
// This could blow up the chain!
.map((_error, result) => {
  throw Error(result)
})
// This "catches" the error and converts it back into a result
.map((error, result) => {
  // The chain will automatically "flatten", waiting for this future
  return Future.fromResult(error.message)
})
// Guaranteed no error
.map((_error, result) => {
  console.info(result)  // '<message>'
})
```

#### `future.mapError(mapper)`

where `mapper: ƒ(error): any`

Variant of [`.map()`](#futuremapmapper) that handles errors and ignores results,
like `.catch()` in promises.

```js
Future.fromError(Error('<fail>'))
  .mapError(error => error.message)
  .map((_error, result) => {
    console.info(result)  // '<fail>'
  })

Future.fromResult('<ok>')
  // Rest easy, this won't happen
  .mapError(error => {
    console.error('Oh noes! Panic!')
    process.exit(1)
  })
  .map((_error, result) => {
    console.info(result)  // '<ok>'
  })
```

#### `future.mapResult(result)`

where `mapper: ƒ(result): any`

Variant of [`.map()`](#futuremapmapper) that handles results and ignores errors,
like `.then()` in promises.

```js
Future.fromError(Error('<fail>'))
  .mapError(error => error.message)
  .map((_error, result) => {
    console.info(result)  // '<fail>'
  })

Future.fromResult('<ok>')
  // Rest easy, this won't happen
  .mapError(error => {
    console.error('Oh noes! Panic!')
    process.exit(1)
  })
  .map((_error, result) => {
    console.info(result)  // '<ok>'
  })
```

#### `future.toPromise()`

Consumes the future, returning a promise of its eventual result. This uses the
built-in `Promise`, which must exist in the global environment.

The returned promise has no control over the operations encapsulated by the
future, and therefore can be passed to multiple consumers without worrying about
one of them aborting the operation for everyone else.

The original future can still be used for control; deiniting it will prevent the
promise from being triggered.

```js
const future = Future.initAsync(future => {
  future.arrive(null, '<async result>')
})

future
  .toPromise()
  .then(result => {
    console.info(result)
  })
  instanceof Promise  // true

future.deinit()  // frees resources, averts promise callbacks
```

#### `future.catch(onRejected)`

where `onRejected: ƒ(error): any`

Shortcut for `.toPromise().catch(onRejected)`. Imitates a promise, making
the future compatible with promise-based APIs such as async/await.

#### `future.then(onResolved)`

where `onResolved: ƒ(result): any`

Shortcut for `.toPromise().then(onResolved)`. Imitates a promise, making
the future compatible with promise-based APIs such as async/await.

#### `future.finishPending()`

Attempts to finish some pending asynchronous operations associated with this
particular future, _right now_. This includes:

  * unhandled rejection
  * triggering a child future
  * [`Future.initAsync`](#futureinitasynciniter) initialiser

Intended to give you more control over _time_, allowing to opt out of
asynchrony. That said, actual use cases for this are rare. If you don't know you
want it, you probably don't need it.

#### `future.deref()`

Attempts to synchronously read the future's value. If pending, returns
`undefined`. If rejected, throws the value. If resolved, returns the value.

Intended to provide more control for esoteric use cases.

#### `future.deinit()`

Deinitialises the future, canceling any pending operations associated with it,
calling its deiniter to free resources (if available), unchaining and deiniting
all other related futures.

Cancelation propagates both upstream and downstream:

```js
// upstream cancelation

const descendant = Future.init(future => {
    // some async work, then:
    future.arrive(null, '<result>')
    return function onDeinit () {/* cancel async work here */}
  })
  .map((error, result) => {
    console.info(error, result)
  })

descendant.deinit()


// downstream cancelation

const ancestor = Future.init(future => {
  // some async work, then:
  future.arrive(null, '<result>')
  return function onDeinit () {/* cancel async work here */}
})

ancestor.map((error, result) => {
  console.info(error, result)
})

ancestor.deinit()
```

### Statics

#### `Future.init(initer)`

where `initer: ƒ(future): (deiniter: ƒ(): void)`

Creates a new future and runs `initer` synchronously, before the end of the
`Future.init` call. Returns the new future. The initer can resolve the future
synchronously or asynchronously. Throwing in the initer is equivalent to
rejection.

The initer can return a _deiniter_ function that will be called when the future
is canceled via [`.deinit()`](#futuredeinit), either directly or as part of a
chain.

Basically it's like the `Promise` constructor, but with cancelation support.

```js
Future.init(future => {
  // runs immediately
  future.arrive(null, '<async result>')
}).mapResult(console.info.bind(console))
  .mapError(console.warn.bind(console))
```

Cancelation:

```js
Future.init(future => {
  const timerId = setTimeout(() => {
    future.arrive(null, '<async result>')
  })
  return function onDeinit () {
    clearTimeout.bind(null, timerId)
  }
}).mapResult(console.info.bind(console))
  .mapError(console.warn.bind(console))
  // calls onDeinit upstream
  .deinit()
```

#### `Future.initAsync(initer)`

where `initer: ƒ(future): (deiniter: ƒ(): void)`

Similar to [`Future.init`](#futureinitiniter), but the initer runs
asynchronously, _after_ the call to `Future.initAsync` returns.

```js
Future.initAsync(future => {
  console.info('initing')
  throw Error('<async init failure>')
})

future.deref()  // doesn't throw yet

// 'initing'
// unhandled rejection warning!
```

#### `Future.from(error, result)`

Shortcut to creating a future that immediately arrives with `error` and
`result`. Similar to `Promise.reject` and `Promise.resolve`, combined into one
"errback" signature. Following the errback convention, the future will be
rejected if `error` is truthy, and successfully resolved otherwise.

```js
Future.from(Error('<error>'), '<unused result>')
  .map((error, result) => {
    console.warn(error)   // '<error>'
    console.info(result)  // undefined
  })

Future.from(null, '<result>')
  .map((error, result) => {
    console.warn(error)   // undefined
    console.info(result)  // '<result>'
  })
```

#### `Future.fromError(error)`

Shortcut to [`Future.from(error, undefined)`](#futurefromerror-result). Similar
to `Promise.reject(error)`.

#### `Future.fromResult(result)`

Shortcut to [`Future.from(undefined, result)`](#futurefromerror-result). Similar
to `Promise.resolve(result)`. Convenient for initialising a future chain from a
constant value.

```js
Future.fromResult('<result>')
  .mapResult(result => someFutureOperation(result))
  .map(console.info.bind(console))
```

#### `Future.all(values)`

Core composition tool, alongside [`Future.race`](#futureracevalues). Coerces
`values` into futures, waits for them, and resolves with a list of their results
or gets rejected with the first error. Basically like `Promise.all`, but with
cancelation support.

Cancelation support:

* on [`.deinit()`](#futuredeinit), deinits all underlying futures
* on error, deinits all underlying futures that are still pending

```js
Future.all([
  '<plain>',
  Future.initAsync(future => {
    future.arrive(null, '<async>')
  }),
])
.mapResult(result => {
  console.info(result)  // ['<plain>', '<async>']
})

Future.all([
  // Rest easy, this won't happen
  Future.initAsync(() => {
    console.error('Oh noes! Panic!')
    process.exit(1)
  }),
  Future.fromError(Error('<early error>'))
])
.mapError(error => {
  console.warn(error)  // '<early error>'
})
```

#### `Future.race(values)`

Core composition tool, alongside [`Future.all`](#futureallvalues). Coerces
`values` into futures, waits for them, and resolves with the first result or
gets rejected with the first error. Basically like `Promise.race`, but with
cancelation support.

Cancelation support:

* on [`.deinit()`](#futuredeinit), deinits all underlying futures
* on first result or error, deinits all underlying futures that are still pending

```js
Future.race([
  Future.init(future => {
    future.arrive(null, '<faster result>')
  }),

  // No worries, this won't blow up
  Future.init(future => {
    const timerId = setTimeout(() => {
      console.error('Oh noes! We were too slow! Panic!')
      process.exit(1)
    }, 50)
    return function onDeinit () {
      clearTimeout(timerId)
    }
  }),
])
.mapResult(result => {
  console.info(result)  // '<faster result>'
})

Future.race([
  Future.initAsync(() => {
    console.error(`I'm gonna blow up first!`)
    process.exit(1)
  }),
  Future.initAsync(() => {
    console.error(`Imma make sure we blow up!`)
    process.exit(1)
  }),
])
.deinit()

// we're ok
```

#### `Future.handleRejection(future)`

Gets called on each unhandled rejection. By default, throws the rejection error.
Feel free to override.

### `isFuture(value)`

Abstract future interface. Checks if `value` has the same shape as a Posterus
[`Future`](#future). Used internally throughout the library. There are no
`instanceof` checks in Posterus, allowing interoperability with a custom Future
implementation.

```js
const {isFuture, Future} = require('posterus')

isFuture(new Future())  // true
isFuture(Future)        // false
```

## Misc

Author: Nelo Mitranim, https://mitranim.com
