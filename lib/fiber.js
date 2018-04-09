'use strict'

// Well tested in production, but still needs tests.

const {Future, isFuture} = require('./posterus')

exports.fiber = fiber
function fiber(iter) {
  validate(iter, isIterator)

  const out = new Future()
  let pending

  function onDone(error, value) {
    out.settle(error, value)
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

    if (isIterator(value)) {
      pending = fiber(value).map(onPendingDone)
      return
    }

    if (isFuture(value)) {
      pending = value.map(onPendingDone)
      return
    }

    // When the iterator synchonously yields over and over in a loop,
    // this recurs deeper every time, costing us stack space and eventually
    // causing a stack overflow exception. This is nicer to debug than an
    // infinite loop that hangs the process. I'm yet to see a legitimate
    // use case for a really long synchronous loop in a coroutine.
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

function isIterator(value) {
  return (
    isObject(value) &&
    isFunction(value.next) &&
    isFunction(value.return) &&
    isFunction(value.throw)
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
