## Overview

Posterus is a library of promise-like asynchronous primitives
([futures](#future)) that support true cancelation. Futures compose just like
promises, but can also be cleanly shut down, aborting pending operations and
freeing resources.

Posterus also exposes its inner [scheduling](#futurescheduler) capabilities,
allowing you to "opt out" of asynchrony when needed.

Lightweight (≈ 7 KB minified + 1 KB dependency), with solid performance (much
more efficient than native promises).

Includes optional future-based coroutines: an alternative to async/await that
supports cancelation of in-progress work. See
[`routine`](#routine).

## TOC

* [Overview](#overview)
* [TOC](#toc)
* [Why](#why)
* [Installation](#installation)
* [TLDR API](#tldr-api)
* [API](#api)
  * [`Future`](#future)
    * [`future.arrive`](#futurearriveerror-result)
    * [`future.map`](#futuremapmapper)
    * [`future.mapError`](#futuremaperrormapper)
    * [`future.mapResult`](#futuremapresultresult)
    * [`future.toPromise`](#futuretopromise)
    * [`future.catch`](#futurecatchonrejected)
    * [`future.then`](#futurethenonresolved)
    * [`future.weak`](#futureweak)
    * [`future.finishPending`](#futurefinishpending)
    * [`future.deref`](#futurederef)
    * [`future.deinit`](#futuredeinit)
  * [Future Statics](#future-statics)
    * [`Future.init`](#futureinitiniter)
    * [`Future.initAsync`](#futureinitasynciniter)
    * [`Future.from`](#futurefromerror-result)
    * [`Future.fromError`](#futurefromerrorerror)
    * [`Future.fromResult`](#futurefromresultresult)
    * [`Future.all`](#futureallvalues)
    * [`Future.race`](#futureracevalues)
    * [`Future.handleRejection`](#futurehandlerejectionfuture)
    * [`Future.scheduler`](#futurescheduler)
  * [`Scheduler`](#scheduler)
    * [`scheduler.tick`](#schedulertick)
    * [`scheduler.asap`](#schedulerasap)
    * [`scheduler.deinit`](#schedulerdeinit)
  * [`isFuture`](#isfuturevalue)
  * [`routine`](#routine)
* [Misc](#misc)

---

## Why

### Why not standard promises?

Cancelation! It's missing from the JS Promise spec, and it's a BIG deal, far
bigger than most developers realise. The ability to stop async operations,
completely freeing resources and memory, has massive benefits that may be
difficult to notice when you don't have it.

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

---

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

---

## TLDR API

Too long, didn't read?

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

* use [coroutines](#routine) for blocking code:

```js
const {Future} = require('posterus')
const {routine} = require('posterus/routine')

const future = routine(outer('<input>'))

function* outer(input) {
  const intermediary = yield Future.fromResult(input)
  let finalResult
  try {
    finalResult = yield inner(intermediary)
  }
  catch (err) {
    console.error(err)
    finalResult = yield Future.fromResult('<replacement>')
  }
  return finalResult
}

function* inner(input) {
  return Future.fromError(input)
}

// Can abort work in progress
future.deinit()
```

---

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

const future = new Future()
future.arrive(null, '<result>')
future.mapResult(result => {
  console.info(result)  // '<result>'
})

// flattens provided future
const future = new Future()
future.arrive(null, Future.fromResult('<future result>'))
future.mapResult(result => {
  console.info(result)  // '<future result>'
})

// waits for provided future
const future = new Future()
future.arrive(null, Future.initAsync(future => future.arrive(null, '<async result>')))
future.mapResult(result => {
  console.info(result)  // '<async result>'
})

// waits for provided future
const future = new Future()
future.arrive(Future.initAsync(future => future.arrive(Error('<async error>'))))
future.mapError(error => {
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

This operation "consumes" the future, disallowing any further chainining from
the same reference. In other words, each future can only have _one consumer_
which has _exclusive ownership_ over it. This allows for cancelation without
unexpected conflicts.

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
  // Won't be called because the future is ok
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
  // Won't be called because the future is not ok
  .mapResult(result => {
    console.info(result)
    console.info('Got it! I quit!')
    process.exit(0)
  })
  .map((error, _result) => {
    console.warn(error)  // '<fail>'
  })

Future.fromResult('<ok>')
  .mapResult(result => {
    return [result]
  })
  .map((_error, result) => {
    console.info(result)  // ['<ok>']
  })
```

#### `future.toPromise()`

Adapter for promise compatibility. Consumes the future, returning a promise of
its eventual result. Uses the JavaScript `Promise` API, which must exist in the
global environment.

The original future can still be used for control; deiniting it will prevent the
promise from being triggered.

Note: if you want to "broadcast" a future to multiple consumers, use
[`.weak()`](#futureweak) instead. `.toPromise()` is strictly less powerful and
should only be used for promise compatibility.

```js
const future = Future.initAsync(future => {
  future.arrive(null, '<async result>')
})

const promise = future
  .toPromise()
  .then(result => {
    console.info(result)
  })

promise instanceof Promise  // true

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

#### `future.weak()`

Creates a "weakly held" branch that doesn't "own" the parent future. Unlike the
regular `.map()` which consumes the future, `.weak()` can create any number of
branches, similar to `.then()` in promises. The tradeoff is that deiniting a
weak branch doesn't propagate cancelation to the parent future or other
branches.

```js
const root = Future.fromResult('<result>')
  .mapResult(/* ... */)
  .mapResult(/* ... */)

const branch0 = root.weak().mapResult(/* ... */)
const branch1 = root.weak().mapResult(/* ... */)

// root can still be consumed
const trunk = root.mapResult(/* ... */)

// has no effect on root, trunk, or other branches
branch0.deinit()
```

Downstream cancelation from the parent affects weak branches, but upstream
cancelation terminates at the `.weak()` future:

```sh
# weak branches from main trunk
* - * - * - * - * - * - * - * - * - * - * - * - *
                            ° - * - * - * - * - * - * - *
                            ° - * - * - *

# downstream
.deinit() - × - × - × - × - × - × - × - × - × - ×
                            × - × - × - × - × - × - × - ×
                            × - × - × - ×

# upstream
* - * - * - * - * - * - * - * - * - * - * - * - *
                            ° - × - × - × - × - × - × - .deinit()
                            ° - * - * - *
```

#### `future.finishPending()`

Attempts to finish the pending asynchronous operations on this particular
future, _right now_. This includes:

* unhandled rejection
* `.map()` callback and propagation of result to child future, if any
* [`Future.initAsync`](#futureinitasynciniter) initialiser

Note: `.finishPending()` affects only the future it's called on. If you want to
synchronously finish _all_ pending operations, call
[`Future.scheduler.tick()`](#futurescheduler).

#### `future.deref()`

Attempts to synchronously read the future's value. If pending, returns
`undefined`. If rejected, throws the value. If resolved, returns the value.

Intended to provide more control for esoteric use cases.

#### `future.deinit()`

Deinitialises the future. Cancels any pending operations associated with it;
calls its `onDeinit`, if any, to free resources; unchains and deinits all other
futures related to it.

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

You can also picture it like this:

```sh
# chain of mapped futures
* - * - * - * - * - * - * - * - * - * - * - * - *

# upstream cancelation
× - × - × - × - × - × - × - × - × - × - .deinit()

# downstream cancelation
.deinit() - × - × - × - × - × - × - × - × - × - ×

# bidirectional cancelation
× - × - × - × - × - .deinit() - × - × - × - × - ×
```

### Future Statics

#### `Future.init(initer)`

where `initer: ƒ(future): (deiniter: ƒ(): void)`

Creates a new future and runs `initer` synchronously, before the end of the
`Future.init` call. Returns the new future. The initer can resolve the future
synchronously or asynchronously. An exception in the initer causes the future to
be rejected.

The initer can return a _deiniter_ function that will be called when the future
is canceled via [`.deinit()`](#futuredeinit), either directly or as part of a
chain.

Similar to the `new Promise(...)` constructor, but with support for cancelation.

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
asynchronously, after the call to `Future.initAsync` is finished.

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

Gets called on each unhandled rejection. By default, rethrows the error
contained in the future. Feel free to override.

#### `Future.scheduler`

Global instance of [`Scheduler`](#scheduler) used for all asynchronous
operations inside Posterus. Exposed to give you more control.

---

### `Scheduler`

Utility for orchestrating async operations. One global instance is exposed as
`Future.scheduler`.

#### `scheduler.tick()`

Attempts to finish all pending async operations, _right now_. Gives you more
control over _time_, allowing to "opt out" of asynchrony in situations that
demand synchronous execution.

Asynchronous operations include:

* unhandled rejections
* `.map()` callbacks and propagation of results from parent to child futures
* [`Future.initAsync`](#futureinitasynciniter) initialisers

`.tick()` is idempotent: it's ok to make redundant calls, or call it before the
next pending tick.

Note that `.tick()` could throw in case of unhandled rejection. In that case,
the remaining operations will remain pending until the next scheduled or manual
tick.

This needs a motivating example.

Suppose we have a React app, and want to wring absolute maximum performance out
of it. View updating is typically one of the most expensive operations, and
often happens redundantly. We can improve performance by pausing view updates
while updating the app state in a network callback, and resuming afterwards.

Scheduling and globally pausing React view updates is a whole separate topic.
I'll just say that you should use [`Prax`](https://mitranim.com/prax/), which
gives you the [capability](https://mitranim.com/prax/api#-renderque-) to pause
and batch React updates, among other things.

```js
const {Future} = require('posterus')
const {RenderQue} = require('prax')
const {Xhttp} = require('xhttp')

function httpRequest (params) {
  return Future.init(future => {
    const xhr = Xhttp(params)
      .onDone(result => {
        // Pauses Prax-enabled React views
        RenderQue.globalRenderQue.dam()

        try {
          if (result.ok) future.arrive(null, result)
          else future.arrive(result)

          // Before we resume view updates,
          // this attempts to finish all pending operations,
          // including future callbacks that could update the app state
          Future.scheduler.tick()
        }
        finally {
          // Resumes view updates
          RenderQue.globalRenderQue.flush()
        }
      })
      .start()

    return function onDeinit () {
      xhr.onabort = null
      xhr.abort()
    }
  })
}
```

#### `scheduler.asap`

The function used for actual async scheduling. In Node, this is
`process.nextTick`. In browser, this uses `MessageChannel` or falls back on
`setTimeout`.

Called internally as `asap(onNextTick)`. Feel free to override with a faster,
slower, or smarter implementation depending on your needs.

#### `scheduler.deinit()`

Empties the pending operation queue. You should never call this on
`Future.scheduler`, but it could be relevant for something custom.

---

### `isFuture(value)`

Abstract interface and boolean test. Checks if `value` has the same shape as a
Posterus [`Future`](#future). Used internally for interoperability with external
futures.

```js
const {isFuture, Future} = require('posterus')

isFuture(new Future())  // true
isFuture(Future)        // false
```

---

### `routine`

Future-based implementation of coroutines. Alternative to async/await based
on futures, with full support for in-progress cancelation.

Must be imported from an optional module.

```js
const {Future} = require('posterus')
const {routine} = require('posterus/routine')

const future = routine(outer('<input>'))

function* outer(input) {
  const intermediary = yield Future.fromResult(input)
  let finalResult
  try {
    finalResult = yield inner(intermediary)
  }
  catch (err) {
    console.error(err)
    finalResult = yield Future.fromResult('<replacement>')
  }
  return finalResult
}

function* inner(input) {
  return Future.fromError(input)
}

// Can abort work in progress
future.deinit()
```

---

## Misc

Author: Nelo Mitranim, https://mitranim.com
