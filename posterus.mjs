export function isTask(val) {
  return isObject(val) &&
    isFunction(val.isDone) &&
    isFunction(val.map) &&
    isFunction(val.mapErr) &&
    isFunction(val.mapVal) &&
    isFunction(val.finally) &&
    isFunction(val.onDeinit) &&
    isFunction(val.done) &&
    isFunction(val.deinit)
}

export class Task {
  constructor() {
    this.d = false     // "done"
    this.i = undefined // "inner"
    this.m = undefined // "mappers"
    this.e = undefined // "deiniters"
  }

  // True if completed OR deinited.
  isDone() {return this.d}

  done(err, val) {
    const self = this
    if (self.d) return

    try {
      /*
      Note: this flag may flip back to "false" after flushing the mappers, but
      pretending that we're "done" during this process prevents reentrant calls
      from mappers.
      */
      self.d = true
      clearInner(self)

      for (;;) {
        if (isTask(err)) {
          linkInnerTaskErr(self, err)
          return
        }

        if (isPromise(err)) {
          linkInnerPromiseErr(self, err)
          return
        }

        if (isTask(val)) {
          linkInnerTask(self, val)
          return
        }

        if (isPromise(val)) {
          linkInnerPromise(self, val)
          return
        }

        let fun
        if (isSeq(this.m)) {
          fun = this.m.shift()
        }
        else {
          fun = this.m
          this.m = undefined
        }
        if (!fun) break

        if (err) val = undefined
        else err = undefined

        try {
          val = fun(err, val)
          err = undefined
        }
        catch (error) {
          val = undefined
          err = error
        }
      }

      maybeThrow(err)
    }
    finally {
      self.d = !self.i
    }
  }

  map(fun) {
    validate(fun, isFunction)
    if (this.d) throw Error(`can't map: task is done`)
    this.m = collPush(this.m, fun)
    return this
  }

  mapErr(fun) {
    validate(fun, isFunction)
    this.map(bind(asMapErr, fun))
    return this
  }

  mapVal(fun) {
    validate(fun, isFunction)
    this.map(bind(asMapVal, fun))
    return this
  }

  // Conceptually similar to "try/finally". The function will run when the task
  // is done, regardless of the result, and without changing the result.
  finally(fun) {
    validate(fun, isFunction)
    this.map(bind(finalize, fun))
    return this
  }

  onDeinit(fun) {
    validate(fun, isFunction)
    if (this.d) throw Error(`can't deinit: task is done`)
    this.e = collPush(this.e, fun)
  }

  deinit() {
    if (this.d) return

    this.d = true
    this.m = undefined

    for (;;) {
      let deiniter
      if (isSeq(this.e)) {
        deiniter = this.e.shift()
      }
      else {
        deiniter = this.e
        this.e = undefined
      }
      if (!deiniter) break
      deiniter()
    }

    clearInner(this)
  }

  toPromise() {
    if (this.isDone()) throw Error(`can't convert to promise: task is done`)
    return new Promise(bind(taskToPromise, this))
  }

  toString() {return 'Task'}

  // Match the behavior of `JSON.stringify` for `Function` instances. Users may
  // intuitively expect this. It's unfortunate that promises don't also
  // implement this.
  toJSON() {return null}
}

function asMapErr(fun, err, val) {
  if (err) return fun(err)
  return val
}

function asMapVal(fun, err, val) {
  maybeThrow(err)
  return fun(val)
}

function finalize(fun, err, val) {
  fun(err, val)
  maybeThrow(err)
  return val
}

const ARRAY_THRESHOLD = 20

function collPush(items, item) {
  if (!items) return item

  if (isArray(items)) {
    if (items.length > ARRAY_THRESHOLD) {
      items = new Que(items)
    }
    items.push(item)
    return items
  }

  if (isInstance(items, Que)) {
    items.push(item)
    return items
  }

  items = [items, item, undefined, undefined]
  items.length = 2
  return items
}

function setInner(outer, innerNext) {
  const inner = outer.i
  outer.i = innerNext
  if (isTask(inner)) inner.deinit()
}

function clearInner(outer) {
  setInner(outer, undefined)
}

function linkInnerTask(outer, inner) {
  setInner(outer, inner.map(bind(transferTaskResult, outer)))
}

function linkInnerTaskErr(outer, inner) {
  setInner(outer, inner.map(bind(transferTaskErr, outer)))
}

function linkInnerPromise(task, promise) {
  setInner(task, promise.then(task.done.bind(task, undefined), task.done.bind(task)))
}

function linkInnerPromiseErr(task, promise) {
  setInner(task, promise.then(task.done.bind(task), task.done.bind(task)))
}

function transferTaskResult(task, err, val) {
  task.done(err, val)
}

function transferTaskErr(task, err, val) {
  task.done(err || val)
}

/*
Creates a branch that inherits the original's error or val. Deiniting the
original also deinits the branch, but deiniting the branch has no effect on the
original.

Note that not handling the original's error might result in unhandled exceptions
that crash a server.

Minor design issue: can we simultaneously handle the original's error and allow
it to propagate to branches? Do we really want to?
*/
export function branch(task) {
  validate(task, isTask)
  const out = new Task()
  task.map(bind(copyResult, out))
  task.onDeinit(out.deinit.bind(out))
  return out
}

function copyResult(out, err, val) {
  out.done(err, val)
  maybeThrow(err)
  return val
}

export function all(inputs) {
  inputs = onlyArray(inputs)
  return initAll(inputs, Array(inputs.length))
}

export function dictAll(inputs) {
  return initAll(onlyDict(inputs), {})
}

function initAll(inputs, outputs) {
  const task = new Task()
  const counter = {n: 0}

  each(inputs, initElement, inputs, outputs, task, counter)
  task.onDeinit(bind(deinitTasks, inputs))

  if (!counter.n) async.push(task, undefined, outputs)
  return task
}

function initElement(input, key, inputs, outputs, task, counter) {
  if (isTask(input)) {
    counter.n++
    input.map(bind(onElementDone, key, inputs, outputs, task, counter))
  }
  else {
    outputs[key] = input
  }
}

function onElementDone(key, inputs, outputs, task, counter, err, val) {
  if (err) {
    task.done(err)
    deinitTasks(inputs)
  }
  else {
    outputs[key] = val
    if (!--counter.n) task.done(undefined, outputs)
  }
}

export function race(inputs) {
  inputs = onlyArray(inputs)

  if (!inputs.length) return async.fromVal()

  const nonTaskIndex = inputs.findIndex(isNonTask)
  if (nonTaskIndex >= 0) {
    deinitTasks(inputs)
    return async.fromVal(inputs[nonTaskIndex])
  }

  const task = new Task()
  const onDone = bind(onRaceElementDone, task, inputs)
  for (let i = 0; i < inputs.length; i += 1) inputs[i].map(onDone)
  task.onDeinit(bind(deinitTasks, inputs))
  return task
}

function onRaceElementDone(task, inputs, err, val) {
  task.done(err, val)
  deinitTasks(inputs)
}

export function fromPromise(promise) {
  const out = new Task()
  linkInnerPromise(out, promise)
  return out
}

function taskToPromise(task, res, rej) {
  task.map(bind(promiseSettle, res, rej))
  task.onDeinit(bind(promiseDeinit, rej))
}

function promiseSettle(res, rej, err, val) {
  if (err) rej(err)
  else res(val)
}

function promiseDeinit(rej) {
  rej(Error(`deinit`))
}

export class AsyncTask extends Task {
  done(err, val) {
    // True if deinited.
    if (this.isDone()) return
    this.done = super.done
    async.push(this, err, val)
  }
}

/*
Adapted from https://github.com/creationix/fastqueue. Modifications:
  * Can be created from an existing array.
  * Mangle private properties to reduce code size.
  * Removed `unshift` support to reduce code size.
*/
export class Que {
  constructor(tail) {
    const self  = this
    tail        = onlyArray(tail)
    self.length = tail.length
    self.h      = []   // "head"
    self.t      = tail // "tail"
    self.i      = 0    // "index"
    self.l      = 0    // "l"
  }

  push(val) {
    this.length++
    this.t.push(val)
  }

  shift() {
    const self = this

    if (self.i >= self.l) {
      const t = self.h
      t.length = 0
      self.h = self.t
      self.t = t
      self.i = 0
      self.l = self.h.length
      if (!self.l) return undefined
    }

    const val = self.h[self.i]
    self.h[self.i++] = undefined
    self.length--
    return val
  }
}

/*
Allows to settle task instances asynchronously. Useful for "pre-done" tasks.
See the `async` variable.

Can be synchronously flushed on demand.
*/
export class Scheduler {
  constructor() {
    const self = this

    self.p = new Que() // "pending"
    self.s = false     // "is scheduled"

    const schedule = chooseAsync(function scheduledTick() {
      self.s = false
      self.tick()
    })

    // "schedule tick"
    self.t = function scheduleTick() {
      if (!self.s) {
        self.s = true
        schedule()
      }
    }
  }

  push(task, err, val) {
    validate(task, isTask)
    const pending = this.p
    pending.push(task)
    pending.push(err)
    pending.push(val)
    this.t()
  }

  fromErr(err) {
    if (!err) throw Error(`expected an error`)
    const out = new Task()
    this.push(out, err, undefined)
    return out
  }

  fromVal(val) {
    const out = new Task()
    this.push(out, undefined, val)
    return out
  }

  tick() {
    const pending = this.p
    while (pending.length) {
      const task = pending.shift()
      const err = pending.shift()
      const val = pending.shift()
      task.done(err, val)
    }
  }
}

// Default scheduler. Useful for making mappable "pre-done" tasks.
export const async = new Scheduler()

/* eslint-disable no-restricted-globals */
function chooseAsync(fun) {
  if (typeof self === 'undefined' && typeof process === 'object' && process && process.nextTick) {
    return function usingNextTick() {
      process.nextTick(fun)
    }
  }

  if (typeof MessageChannel === 'function') {
    const channel = new MessageChannel()
    channel.port1.onmessage = fun
    return function usingMessageChannel() {
      // Note: `postMessage` requires an argument.
      channel.port2.postMessage(undefined)
    }
  }

  return function usingSetTimeout() {
    setTimeout(fun)
  }
}
/* eslint-enable no-restricted-globals */

function each(inputs, fun, ...args) {
  if (isArray(inputs)) {
    for (let i = 0; i < inputs.length; i += 1) {
      fun(inputs[i], i, ...args)
    }
  }
  else {
    for (const key in inputs) fun(inputs[key], key, ...args)
  }
}

function deinitTasks(vals) {
  each(vals, deinitTask)
}

function deinitTask(val) {
  if (isTask(val)) val.deinit()
}

function isNonTask(val) {
  return !isTask(val)
}

function isString(val) {
  return typeof val === 'string'
}

function isFunction(val) {
  return typeof val === 'function'
}

function isObject(val) {
  return val !== null && typeof val === 'object'
}

function isDict(val) {
  if (!isObject(val)) return false
  const proto = Object.getPrototypeOf(val)
  return proto === null || proto === Object.prototype
}

function isArray(val) {
  return isInstance(val, Array)
}

function isSeq(val) {
  return isInstance(val, Que) || isArray(val)
}

function isInstance(val, Class) {
  return (isObject(val) || isFunction(val)) && val instanceof Class
}

function isPromise(val) {
  return isObject(val) && isFunction(val.then)
}

function validate(val, test) {
  if (!test(val)) throw Error(`expected ${show(val)} to satisfy test ${show(test)}`)
}

function show(val) {
  if (isFunction(val) && val.name) return val.name
  if (isArray(val) || isDict(val) || isString(val)) return JSON.stringify(val)
  return `${val}`
}

function bind(fun, ...args) {
  return fun.bind(undefined, ...args)
}

function onlyArray(val) {
  if (val == null) return []
  validate(val, isArray)
  return val
}

function onlyDict(val) {
  if (val == null) return {}
  validate(val, isDict)
  return val
}

function maybeThrow(err) {
  if (err) throw err
}
