/*
Generator-based coroutines for Posterus. Usage:

  import * as p from 'posterus'
  import * as pf from 'posterus/fiber.mjs'

  // Returns a running instance of Posterus `Task`.
  const task = pf.fiber(function*() {
    yield someTask
    yield someTask
    return someValue
  })
*/

import * as p from './posterus.mjs'

export function fiber(iter) {
  validate(iter, isIterator)

  const out = new p.Task()
  let inner

  function iterNext(input) {
    try {onIterNext(iter.next(input))}
    catch (err) {onDone(err)}
  }

  function iterThrow(err) {
    try {onIterNext(iter.throw(err))}
    catch (err) {onDone(err)}
  }

  function onIterNext(next) {
    const val = next.value

    if (next.done) {
      onDone(undefined, val)
      return
    }

    if (isIterator(val)) {
      inner = fiber(val)
      inner = inner.map(onInnerDone)
      return
    }

    if (p.isTask(val)) {
      inner = val.map(onInnerDone)
      return
    }

    iterNext(val)
  }

  function onInnerDone(err, val) {
    inner = undefined
    if (err) iterThrow(err)
    else iterNext(val)
  }

  function onDone(err, val) {
    if (err) out.done(err)
    else if (isIterator(val)) out.done(undefined, fiber(val))
    else if (p.isTask(val)) out.done(undefined, val)
    // Questionable
    else p.async.push(out, undefined, val)
    cleanup()
  }

  function cleanup() {
    if (inner) inner.deinit()
    inner = undefined
    iter.return()
  }

  out.onDeinit(cleanup)

  // The first .next() call "enters" the iterator, ignoring the input
  iterNext()

  return out
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
  if (!test(value)) throw Error(`expected ${value} to satisfy test ${test.name}`)
}
