## Overview

Posterus is a library of promise-like asynchronous primitives (futures) that
support cancelation. Futures compose just like promises, but can also be cleanly
[shut down](#futuredeinit), aborting pending operations and freeing resources.

Posterus also exposes its inner [scheduling](#futurescheduler) capabilities,
allowing you to "opt out" of asynchrony when needed ([motivating
example](#schedulertick)).

Lightweight (≈ 7 KB minified + 1 KB dependency), with solid performance (much
more efficient than "native" promises).

Includes optional support for coroutines. Similar to async/await, but based on
futures, with implicit ownership and cancelation of in-progress work. See
[`routine`](#routine).

Supports interop with promises. Futures automatically
[coerce](#futurethenonresolved) to promises and can be created [from
promises](#futurefrompromisepromise).

Check the [TLDR API](#tldr-api) and the [API](#api). Then read the
[motivation](#why).

## TOC

* [Overview](#overview)
* [TOC](#toc)
* [Why](#why)
  * [Why cancelation?](#why-cancelation)
  * [Why not extend standard promises?](#why-not-extend-standard-promises)
  * [Unicast vs Broadcast](#unicast-vs-broadcast)
  * [Why not Rx observables?](#why-not-rx-observables)
  * [Why not Bluebird?](#why-not-bluebird)
* [Installation](#installation)
* [TLDR API](#tldr-api)
* [API](#api)
  * [`Future`](#future)
    * [`future.settle`](#futuresettleerror-result)
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
    * [`Future.fromPromise`](#futurefrompromisepromise)
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

### Why cancelation?

Humans change their minds all the time. Many behaviors we consider intuitive
rely on some form of cancelation.

  * Start playing a video, then hit stop. Should it finish playing?

  * Click a web link, then immediately click another. Should it still load the first link?

  * Start uploading a file, then hit stop. Should it upload anyway?

  * Run an infinite loop. Should it hog a CPU core until you reboot the operating system?

  * Hit a button to launch nuclear missiles, immediately hit abort. Nuke Rissia anyway?

What does it mean for the programmer?

First, this only applies to user-driven programs. The concept of cancelation to
a normal synchronous program is like the 4th spatial dimension to a human mind:
equally out of reach.

Synchronous code tends to be a sequence of blocking operations, with no room for
changing one's mind. This makes it inherently unresponsive and therefore unfit
for user-driven programs. Said programs end up using event loops and/or
multithreading, inherently asynchronous techniques. The asynchrony is how you
end up needing promises, responding to a fickle user is how you end up needing
cancelation, and being responsive is how you're _able_ to cancel.

Sync and async programming are inherently complementary. For invididual
operations, we tend to think in sequential terms. For systems, we tend to think
in terms of events and reactions. Neither paradigm fully captures the needs of
real-world programming. Most non-trivial systems end up with an asynchronous
core, laced with the macaroni of small sequential programs that perform
individual functions.

JavaScript forces all programs to be asynchonous and responsive. Many of these
programs don't need the asynchrony, don't respond to fickle agents, and could
have been written in Python. Other programs need all of that.

Here's more examples made easier by cancelation.

#### 1. Race against timeout

With promises (broken):

```js
Promise.race([
  after(100).then(() => {
    console.info('running delayed operation')
  }),
  after(50).then(() => {throw Error('timeout')}),
])

function after(time) {
  return new Promise(resolve => setTimeout(resolve, time))
}
```

Timeout wins → delayed operation runs anyway. Is that what we wanted?

Now, with cancelable futures (easy, works):

```js
const {Future} = require('posterus')

Future.race([
  after(100).mapResult(() => {
    console.info('running delayed operation')
  }),
  after(50).mapResult(() => {throw Error('timeout')}),
])

function after(time) {
  return Future.init(future => timeout(time, future.settle.bind(future)))
}

function timeout(time, fun, ...args) {
  return clearTimeout.bind(null, setTimeout(fun, time, ...args))
}
```

Timeout wins → delayed operation doesn't run.

#### 2. Race condition: updating page after network request

Suppose we update search results on a webpage. The user types, we make requests
and render the results. The input might be debounced; it doesn't matter.

With promises:

```js
function onInput() {
  httpRequest(searchParams).then(updateSearchResults)
}
```

Eventually, this happens:

    request 1   start ----------------------------------- end
    request 2            start ----------------- end

After briefly rendering results from request 2, the page reverts to the results
from request 1 that arrived out of order. Is that what we wanted?

Now, let's use futures, and properly overwrite the previous request:

```js
function onInput() {
  if (future) future.deinit()
  future = httpRequest(searchParams).mapResult(updateSearchResults)
}
```

Now there's no race condition.

This could have used `XMLHttpRequest` objects and callbacks, but it shows why
cancelation is a prerequisite for correct async programming.

#### 3. Workarounds in the wild

How many libraries and applications have workarounds like this?

```js
let canceled = false
asyncOperation().then(() => {
  if (!canceled) {/* do work */}
})
const cancel = () => {canceled = true}
```

Live example from the Next.js source: https://github.com/zeit/next.js/blob/708193d2273afc7377df35c61f4eda022b040c05/lib/router/router.js#L298

Workarounds tend to indicate broken APIs.

### Why not extend standard promises?

#### 1. You're already deviating from the spec

Cancelation support diverges from the spec by requiring additional methods. Not
sure you should maintain the appearance of being spec-compliant when you're not.
Using a different interface reduces the chances of confusion, while [automatic
coercion](#futurethenonresolved) to promises and conversion [from
promises](#futurefrompromisepromise) makes interop easy.

#### 2. Unicast is better than broadcast

Promises are _broadcast_: they have multiple consumers. Posterus rejects this
idea and chooses _unicast_: futures have one consumer/owner.

Broadcast promises can support cancelation by using refcounting, like Bluebird.
It works, but at the cost of compromises and edge cases. Adopting a unicast
design lets you avoid them and greatly simplify the implementation.

See [Unicast vs Broadcast](#unicast-vs-broadcast) for a detailed explanation.

#### 3. Annoyances in the standard

##### Errbacks

This is a minor quibble, but I'm not satisfied with `then/catch`. It forces
premature branching by splitting your code into multiple callbacks. Node-style
"errback" continuation is often a better option. Adding this is yet another
deviation. See [`future.map`](#futuremapmapper).

##### External Control

How many times have you seen code like this?

```js
let resolve
let reject
const promise = new Promise((a, b) => {
  resolve = a
  reject = b
})
return {promise, resolve, reject}
```

Occasionally there's a need for a promise that is controlled "externally". The
spec _goes out of its way_ to make it difficult.

In Posterus:

```js
const future = new Future()
```

That's it! Call `future.settle()` to settle it.

##### Error Flattening

`Promise.reject(Promise.resolve(...))` passes the inner promise as the eventual
result instead of flattening it. I find this counterintuitive.

```js
Promise.reject(Promise.resolve('<value>')).catch(value => {
  console.info(value)
})
// Promise { '<value>' }

Future.fromError(Future.fromResult('<value>')).mapError(value => {
  console.info(value)
})
// <value>
```

### Unicast vs Broadcast

Let's define our terms. What Posterus calls a "future", the
[GTOR](https://github.com/kriskowal/gtor) calls a "task": a unit of delayed work
that has only one consumer. GTOR calls this _unicast_ as opposed to promises
which have multiple consumers and are therefore _broadcast_.

Why are promises broadcast, and Posterus unicast? My thoughts are theoretical
and vague. Could be completely wrong. Let's hear them anyway.

Async primitives should be modeled after synchronous analogs:

  * sync → async: it guides the design; the user knows what to expect

  * async → sync: we can use constructs such as coroutines that convert async
    primitives back to the sync operations that inspired them

Let's see how promises map to synchronous constructs:

```js
const first  = '<some value>'
const second = first  // share once
const third  = first  // share again

const first  = Promise.resolve('<some value>')
const second = first.then(value => value)  // share once
const third  = first.then(value => value)  // share again
```

JS promises are modeled after constants. They correctly mirror the memory model
of a GC language: each value can be accessed multiple times and referenced from
multiple places. You could call this _shared ownership_. For this reason, they
_have_ to be broadcast.

Incidentally, research into automatic resource management has led C++ and Rust
people away from shared ownership, towards _exclusive ownerhip_ and [_move
semantics_](https://doc.rust-lang.org/book/second-edition/ch04-01-what-is-ownership.html).
Let's recreate the first example in Rust:

```rs
fn main() {
  let first  = Resource{};
  let second = first;
  let third  = first;       // compile error: use after move
  println!("{:?}", first);  // compile error: use after move

  #[derive(Debug)]
  struct Resource{}

  // This compiles if `Resource` derives the `Copy` trait,
  // but types with destructors don't have that luxury
}
```

With that in mind, look at Posterus:

```js
const first  = Future.fromResult('<some value>')
const second = first.mapResult(value => value)
const third  = first.mapResult(value => value)  // exception: use after move
```

Posterus is unicast because it mirrors the memory model not of JavaScript, but
of _Rust_. In Rust, taking a value _moves_ it out of the original container. (It
also has borrowing, which is impractical for us to emulate.) I believe Rust's
ownership model is a prerequisite for automatic resource management, the next
evolution of GC.

Why force this into a GC language? Same reason C++ and Rust folks ended up with
exclusive ownership and move semantics: it's a better way of dealing with
non-trivial resources such as files, network sockets, and so on. Exclusive
ownerhip makes it easy to deterministically destroy resources, while shared
ownerhip makes it exceedingly difficult.

This idea of exclusive ownership lets you implement automatic resource
management. Implicit, deterministic destructors in JavaScript? Never leaking
those sockets or subscriptions? Yes please! See [Espo →
Agent](https://mitranim.com/espo/#-agent-value-).

### Why not Rx observables?

This is not specifically about Posterus, but seems to be a common sentiment.

Since Rx observables are a superset of promises and streams, some people suggest
using them for everything. I find this view baffling. It implies the desire for
more API surface, more freedom for things to go wrong, and I don't know what to
tell these people.

Let's try a concrete example: they're incompatible with coroutines. Coroutines
map asynchronous primitives to synchronous constructs. Promises map to
constants, streams map to iterators. Since an Rx observable is a superset of
both, you can't map it to either without downcasting it to a promise or a
stream, proving the need for these simpler primitives.

Another reason is API surface and learning curve. We need simple primitives for
simple tasks, going to bigger primitives for specialised tasks. Promises are
hard enough. Don't saddle a novice with mountainous amounts of crap when
promises satisfy the use case.

Since we're talking observables, here's a bonus: a [different
breed](https://mitranim.com/espo/#-atom-value-) of observables that is actually
useful for GUI apps. It enables [implicit GUI
reactivity](https://mitranim.com/prax/api#-praxcomponent-) and automatic
resource management with deterministic destructors (see above).

### Why not Bluebird?

Bluebird now supports upstream cancelation. Why not use it and tolerate the
other [promise annoyances](#3-annoyances-in-the-standard)?

  * The size kills it. At the moment of writing, the core Bluebird bundle is 56
    KB minified. For a browser bundle, that's insanely large just for
    cancelation support. Not caring about another 50 KB is how you end up with
    megabyte-large bundles that take seconds to execute. Posterus comes at 8 KB,
    like a typical promise polyfill.

  * At the moment of writing, Bluebird doesn't cancel promises that lose a
    `Promise.race`. I disagree with these semantics. Some use cases demand that
    losers be canceled. See the [timeout race example](#1-race-against-timeout).

---

## Installation

Install with NPM:

```sh
npm install --exact posterus
```

Then import:

```js
const {Future} = require('posterus')
```

---

## TLDR API

Too long, didn't read?

* create with [`new Future()`](#future),
  [`Future.init`](#futureinitiniter),
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
  future.settle(Error('<async error>'), '<unused result>')
  return function onDeinit () {/* cancel async work here */}
})
.mapResult(result => Future.init(future => {
  // maybe async work, then:
  future.settle(null, '<async result>')
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
    future.settle(null, '<async>')
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
[`.settle()`](#futuresettleerror-result) and/or canceled with
[`.deinit()`](#futuredeinit).

```js
const {Future} = require('future')

const future = new Future()

future.settle(null, '<result>')

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

#### `future.settle(error, result)`

Settles the future with the provided error and result. Similar to the `resolve`
and `reject` callbacks in a Promise constructor, but as a public method,
combined into one "errback" signature. Can be called at any point after creating
the future.

The future is considered rejected if `error` is truthy, and successful
otherwise, like in a typical Node errback.

Just like `Promise.reject` and `Promise.resolve`, accepts other futures and
automatically "flattens", eventually resolving to a non-future.

If the future has previosly been settled or deinited, this is a no-op.

If the future has been previously mapped over, `.settle()` will propagate the
result to the child future.

```js
// Will warn about unhandled rejection
new Future().settle(Error('<error>'))

const future = new Future()
future.settle(null, '<result>')
future.mapResult(result => {
  console.info(result)  // '<result>'
})

// flattens provided future
const future = new Future()
future.settle(null, Future.fromResult('<future result>'))
future.mapResult(result => {
  console.info(result)  // '<future result>'
})

// waits for provided future
const future = new Future()
future.settle(null, Future.initAsync(future => future.settle(null, '<async result>')))
future.mapResult(result => {
  console.info(result)  // '<async result>'
})

// waits for provided future
const future = new Future()
future.settle(Future.initAsync(future => future.settle(Error('<async error>'))))
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

parent.settle(null, '<result>')
```

#### `future.map(mapper)`

where `mapper: ƒ(error, result): any`

Core chaining operation. Takes a "mapper" function and creates a future
representing the transformation of the eventual result of `future` by the
mapper. Compared to promises, this is like a combination of `.then()` and
`.catch()` into one function.

Just like [`.settle()`](#futuresettleerror-result), this automatically
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
  future.settle(null, '<message>')
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
its eventual result. Uses the standard `Promise` constructor, which must exist
in the global environment.

The original future can still be used for control; deiniting it will prevent the
promise from being triggered.

Note: if you want to "broadcast" a future to multiple consumers, use
[`.weak()`](#futureweak) instead. `.toPromise()` is strictly less powerful and
should only be used for promise compatibility.

Note: `future.then()` and `future.catch()` automatically call this, coercing the
future to a promise.

```js
const future = Future.initAsync(future => {
  future.settle(null, '<async result>')
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
branches, similar to `.then()` in promises. Made possible by giving up control:
deiniting a weak branch doesn't propagate cancelation to the parent future or
other branches.

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

Downstream cancelation from the parent affects all weak branches, but upstream
cancelation terminates at the `.weak()` future:

    // weak branches from main trunk
    * - * - * - * - * - * - * - * - * - * - * - * - *
                                ° - * - * - * - * - * - * - *
                                ° - * - * - *

    // downstream
    .deinit() - × - × - × - × - × - × - × - × - × - ×
                                × - × - × - × - × - × - × - ×
                                × - × - × - ×

    // upstream
    * - * - * - * - * - * - * - * - * - * - * - * - *
                                ° - × - × - × - × - × - × - .deinit()
                                ° - * - * - *

#### `future.finishPending()`

Attempts to finish the pending asynchronous operations on this particular
future, _right now_. This includes:

* unhandled rejection
* `.map()` callback and propagation of error/result to child future, if any
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
    future.settle(null, '<result>')
    return function onDeinit () {/* cancel async work here */}
  })
  .map((error, result) => {
    console.info(error, result)
  })

descendant.deinit()


// downstream cancelation

const ancestor = Future.init(future => {
  // some async work, then:
  future.settle(null, '<result>')
  return function onDeinit () {/* cancel async work here */}
})

ancestor.map((error, result) => {
  console.info(error, result)
})

ancestor.deinit()
```

You can also picture it like this:

    // chain of mapped futures
    * - * - * - * - * - * - * - * - * - * - * - * - *

    // upstream cancelation
    × - × - × - × - × - × - × - × - × - × - .deinit()

    // downstream cancelation
    .deinit() - × - × - × - × - × - × - × - × - × - ×

    // bidirectional cancelation
    × - × - × - × - × - .deinit() - × - × - × - × - ×

### Future Statics

#### `Future.init(initer)`

where `initer: ƒ(future): ?(deiniter: ƒ(): void)`

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
  future.settle(null, '<async result>')
}).mapResult(console.info.bind(console))
  .mapError(console.warn.bind(console))
```

Cancelation:

```js
Future.init(future => {
  const timerId = setTimeout(() => {
    future.settle(null, '<async result>')
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

where `initer: ƒ(future): ?(deiniter: ƒ(): void)`

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

Shortcut to creating a future that immediately settles with `error` and
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

#### `Future.fromPromise(promise)`

Utility for interop. Converts the given promise to a future.

```js
const promise = Promise.resolve('<value>')
const future = Future.fromPromise(promise)
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
    future.settle(null, '<async>')
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
    future.settle(null, '<faster result>')
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

function httpRequest(params) {
  return Future.init(future => {
    const xhr = Xhttp(params, result => {
      // Pauses Prax-enabled React views
      RenderQue.globalRenderQue.dam()

      try {
        if (result.ok) future.settle(null, result)
        else future.settle(result)

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

    return function onDeinit() {
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
