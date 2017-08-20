'use strict'

// Needs tests

const {Future, isFuture} = require('./posterus')

exports.routine = routine
function routine (iterator) {
  validate(isIterator, iterator)
  return Future.init(initIteratorRoutine.bind(null, iterator))
}

function initIteratorRoutine (iterator, future) {
  let pending = undefined

  // The first .next() call "enters" the iterator, ignoring arguments
  iterNext()

  function iterNext (value) {
    try {nextStep(iterator.next(value))}
    catch (err) {future.settle(err)}
  }

  function iterThrow (value) {
    try {nextStep(iterator.throw(value))}
    catch (err) {future.settle(err)}
  }

  function nextStep ({value, done}) {
    const proc = isIterator(value) ? routine(value) : value

    if (done) {
      future.settle(undefined, proc)
      return
    }

    if (!isFuture(proc)) {
      nextStep(iterator.next(proc))
      return
    }

    pending = proc.map(errorOrNext)
  }

  function errorOrNext (error, value) {
    pending = undefined
    if (error) iterThrow(error)
    else iterNext(value)
  }

  return function onDeinit () {
    try {
      iterator.return()
    }
    finally {
      if (pending) pending.deinit()
      pending = undefined
    }
  }
}

function isIterator (value) {
  return (
    isObject(value) &&
    isFunction(value.next) &&
    isFunction(value.return) &&
    isFunction(value.throw)
  )
}

function isFunction (value) {
  return typeof value === 'function'
}

function isObject (value) {
  return value != null && typeof value === 'object'
}

function validate (test, value) {
  if (!test(value)) throw Error(`Expected ${value} to satisfy test ${test.name}`)
}
