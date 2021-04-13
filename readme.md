## Overview

Superior replacement for [JS promises](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Guide/Using_promises).

Similarities with promises:

* Supports mapping, flatmapping, grouping, etc.
* Supports coroutines (via generators, see `./fiber.mjs`).

Main differences from promises:

* Supports cancelation.
* Mostly synchronous.
* Exposes its [scheduler](#async), allowing to opt into asynchrony, and _opt out_ by flushing pending tasks on demand.
* Supports "errbacks": single callback that receives "err, val".
* Constructor doesn't require a callback.
* Mapping mutates the task instead of allocating new instances.
* Doesn't store results.
* Dramatically simpler and faster.

Small (<12 KiB unminified) and dependency-free. Usable as a native JS module.

Optionally supports coroutines/fibers (<2 KiB unminified). Replacement for async/await, with implicit ownership and cancelation of in-progress work. See [API (`fiber.mjs`)](#api-fibermjs).

Convertible [to](#tasktopromise) and [from](#frompromisepromise) promises.

## TOC

* [Why](#why)
  * [Why cancelation?](#why-cancelation)
  * [Why not extend standard promises?](#why-not-extend-standard-promises)
  * [Unicast vs Broadcast](#unicast-vs-broadcast)
  * [Why not Rx observables?](#why-not-rx-observables)
  * [Why not Bluebird?](#why-not-bluebird)
* [Usage](#usage)
* [API](#api)
  * [`Task()`](#task)
    * [`task.isDone()`](#taskisdone)
    * [`task.done(err, val)`](#taskdoneerr-val)
    * [`task.map(fun)`](#taskmapfun)
    * [`task.mapErr(fun)`](#taskmaperrfun)
    * [`task.mapVal(fun)`](#taskmapvalfun)
    * [`task.finally(fun)`](#taskfinallyfun)
    * [`task.onDeinit(fun)`](#taskondeinitfun)
    * [`task.deinit()`](#taskdeinit)
    * [`task.toPromise()`](#tasktopromise)
  * [`Scheduler()`](#scheduler)
    * [`scheduler.push(task, err, val)`](#schedulerpushtask-err-val)
    * [`scheduler.fromErr(err)`](#schedulerfromerrerr)
    * [`scheduler.fromVal(val)`](#schedulerfromvalval)
    * [`scheduler.tick()`](#schedulertick)
  * [`AsyncTask()`](#asynctask)
  * [`async`](#async)
  * [`isTask(val)`](#istaskval)
  * [`branch(task)`](#branchtask)
  * [`all(list)`](#alllist)
  * [`dictAll(dict)`](#dictalldict)
  * [`race(list)`](#racelist)
  * [`fromPromise(promise)`](#frompromisepromise)
  * [`toTask(val)`](#totaskval)
* [API (`fiber.mjs`)](#api-fibermjs)
  * [`Fiber()`](#fiber)
  * [`fiber(fun)`](#fiberfun)
  * [`fiberAsync(fun)`](#fiberasyncfun)
  * [`fromIter(iter)`](#fromiteriter)
  * [`fromIterAsync(iter)`](#fromiterasynciter)
* [Changelog](#changelog)

## Why

* Correct async programming requires cancelation.
* `Promise` is crippled by lack of cancelation.
* `Promise` is further mangled by mandatory asynchrony.
* Replacing the broken model is better than trying to augment it.

### Why cancelation?

Humans and even programs change their minds all the time. Many behaviors we consider intuitive rely on some form of cancelation.

* Start playing a video, then hit stop. Should it finish playing?

* Click a web link, then immediately click another. Should it still load the first link?

* Start uploading a file, then hit stop. Should it upload anyway?

* Run an infinite loop. Should it hog a CPU core until you reboot the operating system?

* Hit a button to launch nuclear missiles, immediately hit abort. Nuke another country anyway?

What does it mean for the programmer?

First, this mostly applies to user-driven programs. The concept of cancelation to a normal synchronous program is like the 4th spatial dimension to a human mind: equally incomprehensible.

Synchronous code tends to be a sequence of blocking operations, with no room for changing one's mind. This makes it inherently unresponsive and therefore unfit for user-driven programs. Said programs end up using multithreading, event loops, and other inherently asynchronous techniques. The asynchrony is how you end up with abstractions like promises, responding to a fickle user is how you end up needing cancelation, and being responsive is how you're _able_ to cancel.

Sync and async programming are inherently complementary. For invididual operations, we tend to think in sequential terms. For systems, we tend to think in terms of events and reactions. Neither paradigm fully captures the needs of real-world programming. Most non-trivial systems end up with an asynchronous core, laced with the macaroni of small sequential programs that perform individual functions.

JavaScript forces all programs to be asynchonous and responsive. Many of these programs don't need the asynchrony, don't respond to fickle agents, and could have been written in Python. Other programs need all of that.

Here's more examples made easier by cancelation.

#### 1. Race against timeout

With promises (broken):

```js
Promise.race([
  after(100).then(() => {
    console.log('running delayed operation')
  }),
  after(50).then(() => {throw Error('timeout')}),
])

function after(time) {
  return new Promise(resolve => setTimeout(resolve, time))
}
```

Timeout wins → delayed operation runs anyway. Is that what we wanted?

Now, with cancelable tasks:

```js
import * as p from 'posterus'

p.race([
  after(100).mapVal(() => {
    console.log('running delayed operation')
  }),
  after(50).mapVal(() => {throw Error('timeout')}),
])

function after(time) {
  const task = new p.Task()
  const cancel = timeout(time, task.done.bind(task))
  task.onDeinit(cancel)
  return task
}

function timeout(time, fun, ...args) {
  return clearTimeout.bind(undefined, setTimeout(fun, time, ...args))
}
```

Timeout wins → delayed operation doesn't run, and its timer is _actually_ canceled.

#### 2. Race condition: updating page after network request

Suppose we update search results on a webpage. The user types, we make requests and render the results. The input might be debounced; it doesn't matter.

With regular callbacks or promises:

```js
function onInput() {
  httpRequest(searchParams).then(updateSearchResults)
}
```

Eventually, this happens:

    request 1   start ----------------------------------- end
    request 2            start ----------------- end

After briefly rendering results from request 2, the page reverts to the results from request 1 that arrived out of order. Is that what we wanted?

Instead, we could wrap HTTP requests in tasks, which support cancelation:

```js
function onInput() {
  if (task) task.deinit()
  task = httpRequest(searchParams).mapVal(updateSearchResults)
}
```

Now there's no race.

This could have used `XMLHttpRequest` objects directly, but it shows why cancelation is a prerequisite for correct async programming.

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

Workarounds tend to indicate poor API design.

### Why not extend standard promises?

#### 1. You're already deviating from the spec

Cancelation support diverges from the spec by requiring additional methods. Not sure you should maintain the appearance of being spec-compliant when you're not. Using a different interface reduces the chances of confusion, while conversion [to](#tasktopromise) and [from](#frompromisepromise) promises makes interop easy.

#### 2. Unicast is a better default than broadcast

Promises are _broadcast_: they have multiple consumers. Posterus defaults
to _unicast_: tasks have one consumer/owner, with broadcast as an option.

Broadcast promises can support cancelation by using refcounting, like Bluebird. It works, but at the cost of compromises (pun intended) and edge cases. Defaulting to a unicast design lets you avoid them and greatly simplify the implementation.

See [Unicast vs Broadcast](#unicast-vs-broadcast) for a detailed explanation.

Posterus provides broadcast as an [opt-in](#branchtask).

#### 3. Annoyances in the standard

##### Errbacks

This is a minor quibble, but I'm not satisfied with `then/catch`. It forces premature branching by splitting your code into multiple callbacks. Node-style "errback" continuation is often a better option. Adding this is yet another deviation. See [`task.map`](#taskmapfun).

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

Occasionally there's a need for a promise that is controlled "externally". The spec _goes out of its way_ to make it difficult.

In Posterus:

```js
import * as p from 'posterus'

const task = new p.Task()
```

That's it! Call `task.done()` to settle it.

##### Error Flattening

`Promise.reject(Promise.resolve(...))` passes the inner promise as the eventual result instead of flattening it. I find this counterintuitive.

```js
import * as p from 'posterus'

Promise.reject(Promise.resolve('<result>')).catch(val => {
  console.log(val)
})
// Promise { '<result>' }

p.async.fromErr(p.async.fromVal('<result>')).mapErr(val => {
  console.log(val)
})
// <result>
```

### Unicast vs Broadcast

The [GTOR](https://github.com/kriskowal/gtor) defines a "task" as a unit of delayed work that has only one consumer. GTOR calls this _unicast_ as opposed to promises which have multiple consumers and are therefore _broadcast_.

Why are promises broadcast, and Posterus unicast? My reasons are somewhat vague.

Async primitives should be modeled after synchronous analogs:

* Sync → async: it guides the design; the user knows what to expect.

* Async → sync: we can use constructs such as coroutines that convert async primitives back to the sync operations that inspired them.

Let's see how promises map to synchronous constructs:

```js
const first  = '<some value>'
const second = first  // share once
const third  = first  // share again

const first  = Promise.resolve('<some value>')
const second = first.then(value => value)  // share once
const third  = first.then(value => value)  // share again
```

JS promises are modeled after constants. They correctly mirror the memory model of a GC language: each value can be accessed multiple times and referenced from multiple places. You could call this _shared ownership_. For this reason, they _have_ to be broadcast.

Incidentally, research into automatic resource management has led C++ and Rust people away from shared ownership, towards _exclusive ownerhip_ and [_move semantics_](https://doc.rust-lang.org/book/second-edition/ch04-01-what-is-ownership.html). Let's recreate the first example in Rust:

```rust
// This compiles if `Resource` derives the `Copy` trait, but types with
// destructors don't have that option.
fn main() {
  #[derive(Debug)]
  struct Resource{}

  let first  = Resource{};
  let second = first;
  let third  = first;      // compile error: use after move
  println!("{:?}", first); // compile error: use after move
}
```

With that in mind, look at Posterus:

```js
import * as p from 'posterus'

const task  = p.async.fromVal('<some value>')
task.mapVal(value => value) // returns same instance
task.mapVal(value => value) // returns same instance
```

In Posterus, mapping mutates the task, making it impossible to preserve and access any of the previous steps. It's dramatically simpler and more efficient, but more importantly, it makes it possible to define sensible cancelation semantics.

Posterus is unicast because it mirrors the memory model not of JavaScript, but of _Rust_. In Rust, taking a value _moves_ it out of the original container. (It also has borrowing, which is impractical for us to emulate.) I believe Rust's ownership model is a prerequisite for automatic resource management, the next evolution of GC.

Why force this into a GC language? Same reason C++ and Rust folks ended up with exclusive ownership and move semantics: it's a better way of dealing with non-trivial resources such as files, network sockets, and so on. Exclusive ownerhip makes it easy to deterministically destroy resources, while shared ownerhip makes it exceedingly difficult.

This idea of exclusive ownership lets you implement automatic resource management. Implicit, deterministic destructors in JavaScript? Never leaking websockets or subscriptions? Yes please! See [Espo → Agent](https://mitranim.com/espo/#agent-value-).

### Why not Rx observables?

This is not specifically about Posterus, but seems to be a common sentiment.

Since Rx observables appear to be a superset of promises and streams, some people suggest using them for everything. I find this view baffling. It implies the desire for more layers of crap, more API surface, more freedom for things to go wrong, and I don't know what to tell these people.

One reason would be that observables are not a good building block for coroutines. Coroutines map asynchronous primitives to synchronous constructs. Promises map to constants, streams map to iterators. Since an Rx observable is a superset of both, you can't map it to either without downcasting it to a promise or a stream, proving the need for these simpler primitives.

Another reason is API surface and learning curve. We need simple primitives for simple tasks, going to bigger primitives for specialized tasks. Promises are hard enough. Don't burden a novice with mountainous amounts of crap when promises satisfy the use case.

Since we're talking observables, here's a bonus: a [different breed](https://mitranim.com/espo/#atom-value-) of observables especially fit for GUI apps. It enables [implicit GUI reactivity](https://mitranim.com/espo/#react-views) and automatic resource management with deterministic destructors (see above).

### Why not Bluebird?

Bluebird now supports upstream cancelation. Why not use it and tolerate the other [promise annoyances](#3-annoyances-in-the-standard)?

* The size kills it. At the moment of writing, the core Bluebird bundle is 56 KB minified. For a browser bundle, that's insanely large just for cancelation support. Not caring about another 50 KB is how you end up with megabyte-large bundles that take seconds to execute. Posterus comes at 6 KiB, like a typical promise polyfill.

* At the moment of writing, Bluebird doesn't cancel promises that lose a `Promise.race`. I disagree with these semantics. Some use cases demand that losers be canceled. See the [timeout race example](#1-race-against-timeout).

## Usage

Example of wrapping `XMLHttpRequest` with a cancelable task:

```js
import * as p from 'posterus'

const task = new p.Task()
const xhr = new XMLHttpRequest()

// Oversimplified. Use the `xhttp` library instead.
function onXhrDone({target: xhr, type: reason}) {
  const {status, responseText: body} = xhr

  if (!(status >= 200 && status < 300)) {
    task.done(Error(body))
    return
  }

  const response = {xhr, status, head: xhr.getAllResponseHeaders(), body}
  task.done(undefined, response)
}

// Automatically called when the task is deinited, either directly via
// `task.deinit()`, or indirectly from another task.
task.onDeinit(xhr.abort.bind(xhr))

// Similar to `promise.then`. Chainable. See the API below.
task.map((err, val) => {
  console.log(err, val)
})

xhr.onerror = xhr.onload = xhr.ontimeout = onXhrDone
xhr.open('get', '/')
xhr.send()

// Aborts the request.
task.deinit()
```

## API

All examples imply an import:

```js
import * as p from 'posterus'
```

### `Task()`

Creates a pending task that can be settled with [`.done()`](#taskdoneerr-val) or canceled with [`.deinit()`](#taskdeinit).

```js
const task = new p.Task()

task
  .map((err, val) => {
    console.log(err, val)
  })
  .mapVal(val => {
    console.log(val)
  })
  .mapErr(err => {
    console.warn(err)
  })

// Eventually, trigger the chain:
task.done(undefined, '<result>')

// Or cancel:
task.deinit()
```

#### `task.isDone()`

Returns `true` if the task has been settled or deinited:

```js
const task = new p.Task()
task.isDone() // false
task.done()
task.isDone() // true
```

Note that unlike `Promise`, Posterus' `Task` does _not_ store its result. This allows to dramatically simplify the API and implementation.

#### `task.done(err, val)`

Settles the task with the provided error and result. Similar to the `resolve` and `reject` callbacks in a `Promise` constructor, but as an instance method, combined into one "errback" signature. Can be called at any point after creating the task.

The task is considered rejected if `error` is truthy, and successful otherwise, like in a typical Node errback.

Unlike promises, a task runs its callbacks _synchronously_. If there's an unhandled error, the caller of `.done()` can/must handle it via try/catch. This dramatically simplifies the implementantion, the mental model, and helps to avoid unhandled rejections.

Either `err` or `val` can be a task. In this case, it's "flattened": the current task will wait for its completion. In addition, the current task takes "ownership" of any task passed to `.done()`, and will deinit it alongside itself on a call to [`.deinit()`](#taskdeinit).

If the task has previosly been settled or deinited, this is a no-op.

```js
// Synchronous exception.
new p.Task().done(Error('<error>'))

const task = new p.Task()
task.done(undefined, '<result>')
task.mapVal(val => {
  console.log(val)  // '<result>'
})

// Flattens provided task.
const task = new p.Task()
task.done(undefined, p.async.fromVal('<task result>'))
task.mapVal(val => {
  console.log(val)  // '<task result>'
})

// Waits for provided task.
const task = new p.Task()
const inner = new p.Task()
task.done(undefined, inner)
task.mapVal(val => {
  console.log(val)  // '<async result>'
})
inner.done(undefined, '<async result>')
```

#### `task.map(fun)`

where `fun: ƒ(err, val): any`

Core chaining operation. Registers a function that will transform the task's result or error. The function's return value becomes the task's result, and the function's throw becomes the task's error. Either may be further transformed by other mappers.

Compared to promises, this is like a combination of `.then()` and `.catch()` into one function. Unlike promises, this _mutates the task and returns the same instance_.

Because Posterus tasks don't store their results, calling `.map()` after the task is settled (via `.done()`) produces a synchronous exception. For asynchrony, use [`async`](#async) and [`AsyncTask`](#asynctask).

Just like [`.done()`](#taskdoneerr-val), this automatically "flattens" the tasks returned or thrown by the mapper(s), eventually resolving to non-task values. This is known as "flatmap" in some languages.

Takes "ownership" of any task returned or thrown by a mapper, and will deinit the inner task on a call to [`.deinit()`](#taskdeinit).

All other chaining operations are defined in terms of `.map()` and share these characteristics.

```js
p.async.fromVal('<message>')
  // This could blow up the chain!
  .map((_err, val) => {
    throw Error(val)
  })
  // This "catches" the error and converts it back into a result.
  .map((err, val) => {
    // The chain will automatically "flatten", waiting for this task.
    return p.async.fromVal(err.message)
  })
  // Guaranteed no error.
  .map((_err, val) => {
    console.log(val)  // '<message>'
  })
```

#### `task.mapErr(fun)`

where `fun: ƒ(err): any`

Variant of [`.map()`](#taskmapfun) where the function is called only for errors, like `.catch()` in promises.

```js
p.async.fromErr(Error('<fail>'))
  // Converts error to value.
  .mapErr(err => err.message)
  // Called with value, not error.
  .map((_err, val) => {
    console.log(val)  // '<fail>'
  })

p.async.fromVal('<ok>')
  // Won't be called because no error.
  .mapErr(err => {
    console.error('Oh noes! Panic!')
    process.exit(1)
  })
  .map((_error, val) => {
    console.log(val)  // '<ok>'
  })
```

#### `task.mapVal(fun)`

where `fun: ƒ(val): any`

Variant of [`.map()`](#taskmapfun) where the function is called only for non-errors, like `.then()` in promises.

```js
p.async.fromErr(Error('<fail>'))
  // Won't be called because there's an error.
  .mapVal(val => {
    console.log(val)
    console.log('Got it! I quit!')
    process.exit(0)
  })
  .map((err, _val) => {
    console.warn(err)  // Error('<fail>')
  })

p.async.fromVal('<ok>')
  // Transforms the result.
  .mapVal(val => {
    return [val]
  })
  .map((_error, val) => {
    console.log(val)  // ['<ok>']
  })
```

#### `task.finally(fun)`

where `fun: ƒ(err, val): void`

Variant of [`.map()`](#taskmapfun) that doesn't change the result.

Like in synchronous `try/finally`, if this function throws, the resulting error overrides the previous result or error. Unlike `try/finally`, a value returned by this function does not override the previous result.

Because the return value of the function is ignored, this _does not_ flatmap any returned tasks. Use `.finally` only for synchronous operations.

```js
p.async.fromVal('<result>')
  // Does not change the result.
  .finally((err, val) => {
    console.log(err, val) // undefined, <result>
    return '<ignored>'
  })
  .mapVal(val => {
    console.log(val) // '<result>'
  })

p.async.fromErr(Error('<fail>'))
  // Does not "catch" the error.
  .finally(err => {
    console.log(err) // Error('<fail>')
  })
  .mapErr(err => {
    console.warn(err) // Error('<fail>')
  })
```

Note that since version `0.5.0`, you must use [`task.onDeinit`](#taskondeinitfun) rather than `.finally` to register cleanup functions.

#### `task.onDeinit(fun)`

where `fun: ƒ(): void`

Registers a function that will be called when the task is deinited, either directly or through its descendants. Can be called multiple times to register multiple functions. Use it for cleanup:

```js
const task = new p.Task()

// Represents an arbitrary async operation.
// Could be an HTTP request, etc.
const timer = setTimeout(() => {task.done()})

const cancel = clearTimeout.bind(undefined, timer)

task.onDeinit(cancel)

task
  // Never called because of subsequent deinit.
  .mapVal(() => {throw Error('panic')})
  .deinit()
```

#### `task.deinit()`

Synchronously aborts the task. Prevents any [`.map`](#taskmapfun)-based callbacks from being invoked. If the task was waiting on an inner task, calls `.deinit` on the inner task. Synchronously calls any functions registered by [`.onDeinit`](#taskondeinitfun).

```js
const task = new p.Task()

// Represents an arbitrary async operation.
// Could be an HTTP request, etc.
const timer = setTimeout(() => {task.done()})

const cancel = clearTimeout.bind(undefined, timer)

task.onDeinit(cancel)

task
  // Never called because of subsequent deinit.
  .mapVal(() => {throw Error('panic')})
  .deinit()
```

#### `task.toPromise()`

Converts the task to a promise, using the standard `Promise` constructor, which must exist in the global environment. Mutates the task by calling [`.map`](#taskmapfun), transforming its result to `undefined`.

Deiniting the original task causes the resulting promise to be rejected with an error.

```js
const task = p.async.fromVal('<result>')

task
  .toPromise()
  // Would log '<result>' but never gets called, see below.
  .then(val => {
    console.log(val)
  })
  .catch(err => {
    console.warn(err) // Error('deinit')
  })

promise instanceof Promise // true

task.deinit() // Rejects the promise.
```

### `Scheduler()`

Utility for settling tasks asynchronously. One global instance is exposed as
[`async`](#async).

#### `scheduler.push(task, err, val)`

Will call `task.done(err, val)` after a small delay. Used internally by `.fromErr` and `.fromVal`.

#### `scheduler.fromErr(err)`

Similar to `Promise.reject`. Returns a new task for which `task.done(err, undefined)` will be called after a small delay. Usually invoked on the global `async` instance:

```js
const task = p.async.fromErr(Error('fail'))

task.mapErr(err => {
  console.warn(err)
})
```

#### `scheduler.fromVal(val)`

Similar to `Promise.resolve`. Returns a new task for which `task.done(undefined, val)` will be called after a small delay. Usually invoked on the global `async` instance:

```js
const task = p.async.fromVal('<result>')

task.mapVal(val => {
  console.log(val)
})
```

#### `scheduler.tick()`

Attempts to finish all pending async operations, _right now_. Gives you more
control over _time_, allowing to "opt out" of asynchrony in situations that
demand synchronous execution.

The scheduler flushes all pending tasks by calling [`task.done`](#taskdoneerr-val) on each. Then, `task.done` synchronously calls functions registered via [`task.map`](#taskmapfun) and derivatives. As a result, this will run all task-related callbacks that could possibly run now.

Usually invoked on the global [`async`](#async) instance. Example:

```js
// Delayed, doesn't run yet.
p.async.fromVal('<result>')
  .mapVal(val => {
    console.log(val)
  })

// Immediately runs the callback above, logging '<result>'.
p.async.tick()
```

### `AsyncTask()`

Variant of [`Task`](#task) whose [`.done()`](#taskdoneerr-val) is asynchronous. Instead of settling the task and calling mapper functions immediately, calling `.done()` schedules the task to be settled after a small delay.

Uses the default global scheduler [`async`](#async). Can be immediately flushed via [`async.tick()`](#schedulertick):

```js
const task = new p.AsyncTask()

// Schedules to be settled after a small delay.
task.done(undefined, '<result>')

// Unlike `Task`, calling `.map` after `.done` is allowed.
task.mapVal(val => {
  console.log(val)
})

// Immediately runs the callback above, logging '<result>'.
p.async.tick()
```

### `async`

Global instance of [`Scheduler`](#scheduler). This is never implicitly used by `Task`. Asynchrony is always opt-in. See the [`Scheduler`](#scheduler) examples above.

### `isTask(val)`

Defines the "task interface". All Posterus functions and methods that accept tasks test their inputs via this function, allowing external implementations, and without any "secret fast paths" for Posterus' own classes.

```js
p.isTask(new p.Task())  // true
p.isTask(p.Task)        // false
```

### `branch(task)`

Creates a "weakly held" branch that doesn't "own" the parent task. It inherits the original's result and cancelation, but does not change the original's result, and deiniting a branch does not deinit the original.

Mind the order: because [`.map`](#taskmapfun) mutates a task, you need to register branches _before_ further mapping the original. For example, to handle the original's error, you must create branches first, _then_ use [`.mapErr`](#taskmaperrfun).

```js
const trunk = p.async.fromErr(Error('<error>'))
const branch0 = p.branch(trunk).mapErr(console.warn)
const branch1 = p.branch(trunk).mapErr(console.warn)

// Handle the original's error. Must be called after branching.
trunk.mapErr(console.warn)

// Has no effect on the trunk or other branches.
branch0.deinit()
branch1.deinit()

// This WILL deinit the branches.
trunk.deinit()
```

### `all(list)`

Similar to `Promise.all`. Takes a list of values, which may or may not be tasks, and returns a single task that waits for them to complete. The resulting task is eventually settled with a list of results.

Unlike `Promise.all`, supports cancelation:

* On [`.deinit()`](#taskdeinit), deinits all underlying tasks.

* On error, deinits all underlying tasks that are still pending.

```js
p.all([
  'one',
  p.async.fromVal('two'),
  p.async.fromVal().mapVal(() => 'three'),
])
.mapVal(vals => {
  console.log(vals) // ['one', 'two', 'three']
})

p.all([
  p.async.fromErr(Error('err')),
  // Will NOT be called: the error above causes deinit.
  p.async.fromVal().mapVal(panic),
])
.mapErr(err => {
  console.warn(err) // Error('err')
})

// If this ever runs, it might crash the process.
// `all` will make sure it doesn't happen.
function panic() {
  console.error(Error('panic'))
  process.exit(1)
}
```

### `dictAll(dict)`

Same as [`all`](#alllist), but the input and output are dicts. Has the same cancelation semantics.

```js
p.all({
  one: 10,
  two: p.async.fromVal(20),
})
.mapVal(vals => {
  console.log(vals) // {one: 10, two: 20}
})
```

### `race(list)`

Similar to `Promise.race`. Takes a list of values, which may or may not be tasks, and returns a single task that resolves with the _first_ error or value that "wins" the race.

Unlike `Promise.race`, this automatically deinits every task that didn't "win".

```js
p.race([
  // Wins the race.
  p.async.fromVal('<result>'),
  // Loses the race and gets deinited.
  p.async.fromVal().mapVal(panic),
]).mapVal(val => {
  console.log(val) // '<result>'
})

p.race([
  p.async.fromVal().mapVal(panic),
  p.async.fromVal().mapVal(panic),
])
// Cancels all competitors.
.deinit()

// Still alive!

// If this ever runs, it might crash the process.
// `race` will make sure it doesn't happen.
function panic() {
  console.error(Error('panic'))
  process.exit(1)
}
```

### `fromPromise(promise)`

Interop utility. Converts a promise to a task. Also see [`toTask`](#totaskval).

```js
const promise = Promise.resolve('<value>')
const task = p.fromPromise(promise)
```

### `toTask(val)`

Interop utility. Converts any value to a task. Tasks are returned as-is; promises are converted via `fromPromise`; other values are scheduled on the default scheduler instance via [`scheduler.fromVal(val)`](#schedulerfromvalval).

```js
const task0 = p.toTask(p.async.fromVal(10)) // Returned as-is.
const task1 = p.toTask(Promise.resolve(20))
const task2 = p.toTask(30)
```

## API (`fiber.mjs`)

The optional module `posterus/fiber.mjs` implements fibers (coroutines) via generators. Superior replacement for `async` / `await`, with implicit cancelation of in-progress work.

Basic usage:

```js
import * as p from 'posterus'
import * as pf from 'posterus/fiber.mjs'

function* simpleGen(val) {
  val = yield val
  return val
}

const fiberSync = pf.fiber(simpleGen)
const fiberAsync = pf.fiberAsync(simpleGen)

const val = fiberSync('val')
const task = fiberAsync('val')
```

Fibers are composable: they can wait on tasks or iterators returned by generator functions. They support automatic cleanup: deiniting an outer fiber that's blocked on an inner fiber will deinit both.

```js
import * as p from 'posterus'
import * as pf from 'posterus/fiber.mjs'

const outer = pf.fiber(function* (val) {
  val = yield inner(val)
  return val + 10
})

const inner = pf.fiber(function* (val) {
  val = yield p.async.fromVal(val)
  return val + 10
})

// Currently waiting on `inner` and `fromVal`.
const task = outer(10)

task.mapVal(console.log) // Would log "30" unless deinited.

// Deinits all three tasks: outer, inner, and `fromVal`.
task.deinit()
```

### `Fiber()`

Subclass of [`Task`](#task) that tracks the lifecycle of an iterator object returned by a generator function. Created by all functions in this module. You shouldn't need to construct it directly, but it's exported for completeness, as a building block.

A newly-constructed `Fiber` is inert; it doesn't immediately "enter" the procedure, and is pending forever. To start it, call `.done()`.

```js
function* gen() {}

const fib = new pf.Fiber(gen())

fib.map((err, val) => {/* ... */})

// Starts execution. May synchronously return the result, if possible.
const val = fib.done()
```

### `fiber(fun)`

Wraps a generator function. The resulting function invokes [`fromIter`](#fromiteriter), returning either the resulting value (if possible), or a pending task.

```js
const fibSync = pf.fiber(function* genSync(val) {
  val = (yield val) + 10
  return val
})

const fibAsync = pf.fiber(function* genAsync(val) {
  val = (yield p.async.fromVal(val)) + 10
  return val
})

console.log(fibSync(10))         // 20
console.log(fibAsync(10))        // Task {}
fibAsync(10).mapVal(console.log) // 20
```

### `fiberAsync(fun)`

Wraps a generator function. The resulting function invokes [`fromIterAsync`](#fromiterasynciter), always returning a pending task. Note that `fromIterAsync` does _not_ immediately start execution; the wrapped function is always scheduled to execute asynchronously, but can be flushed synchronously via [`async.tick()`](#schedulertick).

```js
const fibAsync0 = pf.fiberAsync(function* genSync(val) {
  val = (yield val) + 10
  return val
})

const fibAsync1 = pf.fiberAsync(function* genAsync(val) {
  val = (yield p.async.fromVal(val)) + 10
  return val
})

console.log(fibAsync0(10))        // Task {}
console.log(fibAsync1(10))        // Task {}
fibAsync0(10).mapVal(console.log) // 20
fibAsync1(10).mapVal(console.log) // 20
```

### `fromIter(iter)`

Takes an iterator object (returned by calling a generator function) and attempts to execute it synchronously. If successful, returns the resulting value or throws an error. Otherwise, returns a pending task.

```js
function* genSync(val) {
  val = (yield val) + 10
  return val
}

function* genAsync(val) {
  val = (yield p.async.fromVal(val)) + 10
  return val
}

const val  = pf.fromIter(genSync(10))  // 20
const task = pf.fromIter(genAsync(10)) // Task {}
task.mapVal(console.log)               // 20
```

### `fromIterAsync(iter)`

Takes an iterator object (returned by calling a generator function) and schedules it to be executed asynchronously, on the default scheduler [instance](#async). Returns a pending task. Can be flushed synchronously via [`async.tick()`](#schedulertick).

```js
function* genSync(val) {
  val = (yield val) + 10
  return val
}

function* genAsync(val) {
  val = (yield p.async.fromVal(val)) + 10
  return val
}

const task0 = pf.fromIterAsync(genSync(10))  // Task {}
const task1 = pf.fromIterAsync(genAsync(10)) // Task {}
task0.mapVal(console.log)                    // 20
task1.mapVal(console.log)                    // 20
```

## Changelog

### 0.6.1

Fixed an edge case where fibers would swallow exceptions thrown by mappers.

Slightly reduced the unminified size of both files.

### 0.6.0

**Revised fibers**: dramatically simpler, more efficient, fully synchronous by default. Async is opt-in. Breaking API changes:

  * `pf.fiber` now wraps a generator function, returning a function that uses `pf.fromIter`.

  * Added `pf.fiberAsync`: wraps a generator function, returning a function that uses `pf.fromIterAsync`.

  * Added `pf.fromIter`: takes an iterator and immediately executes, returning a non-task value if possible, otherwise returning a pending task.

  * Added `pf.fromIterAsync`: takes an iterator and schedules its execution on the default `p.Scheduler` (`p.async`), returning a pending task.

**Breaking**: removed automatic from-promise conversion. When using promise-returning functions, follow up with `p.fromPromise`:

```js
const task = new p.Task()

task
  .mapVal(() => Promise.resolve('val'))
  .mapVal(p.fromPromise)

task.done(undefined, p.fromPromise(Promise.resolve('val')))
```

Relatively **non-breaking**: `task.done()` now returns either the resulting value (if finished just now), or the task itself (if pending). The value is not stored; subsequent `task.done()` on a completed task returns `undefined`. This is useful in edge cases; for example, it allows the fiber implementation to be significantly simpler and more efficient.

**Non-breaking**: added `toTask` for converting arbitrary values to tasks.

### 0.5.1

`task.done()` and `task.map()`, and other methods defined in terms of them, now implicitly support promises, waiting for their completion.

Restored the ability to wait on tasks and promises passed as errors to `.done()` or thrown by mappers, which was erroneously omitted in the rework.

### 0.5.0

Breaking revision:

  * Dramatically simpler and faster.
  * Mostly synchronous.
  * Mapping mutates the instance instead of allocating a new one.
  * Deinit callbacks are registered separately, instead of using `.finally`.
  * Cancelation is silent, without special errors.
  * Renamed "future" to "task".
  * Provides only native JS modules.

The new design had incubated in production for about 2 years before being published, and is considered mature.

Now licensed under [Unlicense](https://unlicense.org).

### 0.4.6

With Webpack or other bundlers, `import 'posterus/fiber'` now chooses the ES2015 version, whereas `require('posterus/fiber')` in Node still chooses the CommonJS version.

### 0.4.4, 0.4.5

Added ES modules. When using `import 'posterus'`, bundlers such as Webpack should automatically use the version from the `es` folder. This makes it compatible with module concatenation, tree shaking, etc.

### 0.4.3

Future.all no longer gets slower with large input arrays.

Probably irrelevant in real world code, but could make us look bad in artificial microbenchmarks.

### 0.4.2

Bugfixed a rare edge case in `.all` and `.race`.

### 0.4.1

Unignored `posterus/fiber` for NPM and removed `posterus/routine`.

### 0.4.0: dependency-free, smaller size

Inlined the `fastqueue` dependency with modifications that reduce the minified size. Use ES5-style classes and other tweaks to avoid generating Babel garbage and produce minificable code. This reduces the total size from ≈8 KiB to ≈6 KiB.

### 0.3.4: better fiber promise support

You can now also `return` promises from fibers.

### 0.3.3: fiber promise support

You can now `yield` promises in fibers.

### 0.3.2: bugfix

Corrected an obscure fiber bug.

### 0.3.1: renamed `routine` → `fiber`

Æsthetic change. Renamed coroutines to fibers:

```js
const {fiber} = require('posterus/fiber')
const future = fiber(function*() {}())
```

The `require('posterus/routine').routine` export worked until `0.4.1`.

### 0.3.0: breaking changes focused on termination

Big conceptual revision. Now, "cancelation" is defined as settling the future chain with an error. Posterus no longer cancels your callbacks, so your code always runs and terminates.

This also removes `Future.init`, `Future.initAsync`, and special cancelation-only callbacks they supported. They become unnecessary when cancelation is just an error: deinit logic can be put in a `.finally` callback. When deiniting a descendant future, callbacks on ancestor futures are called synchronously to ensure immediate cleanup.

The new behavior better aligns with synchronous code. Consider Java threads and futures: `thread.stop()`, `thread.interrupt()`, `future.cancel()` throw an exception into a thread, moving execution to the nearest `catch` or `finally` block. It doesn't completely stop the thread's code from executing, and there aren't any special cancelation-only blocks of code.

Other changes and improvements:

  * `.all` and `.race` created from deinited futures will now settle with an
    error instead of hanging up

  * empty `.race([])` now immediately settles with `undefined` instead of
    hanging up

  * deiniting a future after settling no longer prevents callbacks from running;
    instead, this suppresses the rejection handler and deinits its ancestors, if
    any

  * weaks created before and after settling a future settle in the same order

  * better compatibility with subclassing

## License

https://unlicense.org

## Misc

I'm receptive to suggestions. If this library _almost_ satisfies you but needs changes, open an issue or chat me up. Contacts: https://mitranim.com/#contacts
