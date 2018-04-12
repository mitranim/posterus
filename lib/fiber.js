'use strict'

// Needs tests.

const {Future, isFuture} = require('./posterus')

exports.fiber = fiber
function fiber(iter) {
  validate(iter, isIterator)

  const out = new Future()
  let pending

  function onDone(error, value) {
    if (error) out.settle(maybeToFuture(error))
    else out.settle(undefined, maybeToFuture(value))
    if (pending) pending.deinit()
    pending = undefined
    iter.return()  // unlikely to except
  }

  function iterNext(input) {
    try {onIterNext(iter.next(input))}
    catch (err) {onDone(err)}
  }

  function iterThrow(error) {
    try {onIterNext(iter.throw(error))}
    catch (err) {onDone(err)}
  }

  function onIterNext({value, done}) {
    if (done) {
      onDone(undefined, value)
      return
    }

    value = maybeToFuture(value)

    if (isFuture(value)) {
      pending = value.map(onPendingDone)
      return
    }

    // When the iterator synchonously yields over and over in a loop,
    // this recurs deeper every time, costing us stack space and eventually
    // causing a stack overflow exception. This is nicer to debug than an
    // infinite loop that hangs the process. I'm yet to see a legitimate
    // use case for a really long synchronous loop in a coroutine.
    // This doesn't apply to an infinite loop that yields on every iteration.
    iterNext(value)
  }

  function onPendingDone(error, value) {
    pending = undefined
    if (error) iterThrow(error)
    else iterNext(value)
  }

  // The first .next() call "enters" the iterator, ignoring the input
  iterNext()

  return out.finally(onDone)
}

function maybeToFuture(value) {
  return (
    isFuture(value)
    ? value
    : isIterator(value)
    ? fiber(value)
    : isPromise(value)
    ? Future.fromPromise(value)
    : value
  )
}

function isIterator(value) {
  return (
    isObject(value) &&
    isFunction(value.next) &&
    isFunction(value.return) &&
    isFunction(value.throw)
  )
}

function isPromise(value) {
  return (
    isObject(value) &&
    isFunction(value.then) &&
    isFunction(value.catch)
  )
}

function isFunction(value) {
  return typeof value === 'function'
}

function isObject(value) {
  return value != null && typeof value === 'object'
}

function validate(value, test) {
  if (!test(value)) throw Error(`Expected ${value} to satisfy test ${test.name}`)
}
