'use strict'

const Queue = require('fastqueue')

/**
 * Interfaces
 */

exports.isFuture = isFuture
function isFuture (value) {
  return (
    Boolean(value) &&
    isFunction(value.deref) &&
    isFunction(value.arrive) &&
    isFunction(value.map) &&
    isFunction(value.mapError) &&
    isFunction(value.mapResult) &&
    isFunction(value.toPromise) &&
    isFunction(value.catch) &&
    isFunction(value.then) &&
    isFunction(value.finishPending) &&
    isFunction(value.deinit)
  )
}

/**
 * Scheduler
 */

class Scheduler {
  constructor () {
    this.pending_ = new Queue()
    this.isScheduled_ = false
    this.onScheduledTick_ = onScheduledTick.bind(null, this)
    this.asap = chooseAsapImplementation(this.onScheduledTick_)
  }

  push (future) {
    // Could be redundant, not worth deduplicating
    this.pending_.push(future)
    if (this.pending_.length) scheduleTick(this)
  }

  // Can be called synchronously to drain the pending que
  tick () {
    // Ensures exception resilience without masking the throw site
    try {
      while (this.pending_.length) this.pending_.shift().finishPending()
    }
    finally {
      if (this.pending_.length) scheduleTick(this)
    }
  }

  deinit () {
    this.pending_ = new Queue()
  }
}

exports.Scheduler = Scheduler

function scheduleTick (scheduler) {
  if (!scheduler.isScheduled_) {
    scheduler.isScheduled_ = true
    scheduler.asap.call(null, scheduler.onScheduledTick_)
  }
}

function onScheduledTick (scheduler) {
  scheduler.isScheduled_ = false
  scheduler.tick()
}

/**
 * Future
 */

class Future {
  constructor () {
    this.state = this.states.PENDING
    this.value_ = undefined
    this.mappedFrom_ = undefined
    this.mappedInto_ = undefined
    this.waitingFor_ = undefined
    this.mapper_ = undefined
    this.deiniter_ = undefined
    this.pendingIniter_ = undefined
    this.pendingRejection_ = false
    this.consumed_ = false
  }

  // TODO document
  deref () {
    if (this.state === this.states.ERROR) {
      this.pendingRejection_ = false
      throw this.value_
    }
    return this.value_
  }

  // WTB: ideally, we should distinguish "premature" completion from "planned"
  // completion. Premature completion should invoke the current deiniter,
  // whereas planned completion shouldn't.
  arrive (error, result) {
    if (this.state !== this.states.PENDING) return

    if (error === this || result === this) {
      throw Error(`A future can't be chained to itself`)
    }

    this.deiniter_ = undefined

    if (error && isAmbiguousFuture(result)) {
      try {result.deinit()}
      finally {this.arrive(error)}
      return
    }

    if (isAmbiguousFuture(error)) {
      this.waitingFor_ = error.map(arriveAtMappedError.bind(null, this))
      return
    }

    if (isAmbiguousFuture(result)) {
      this.waitingFor_ = result.map(arriveAtMappedResult.bind(null, this))
      return
    }

    const mapper = this.mapper_
    this.mapper_ = undefined
    if (isFunction(mapper)) {
      let mappedResult = null
      try {
        mappedResult = mapper.call(this, error, result)
      }
      catch (err) {
        arriveWithCaughtError(this, err)
        return
      }
      // We don't anticipate exceptions here, so if something unexpected
      // happens, let it blow up early.
      this.arrive(undefined, mappedResult)
      return
    }

    this.state = error ? this.states.ERROR : this.states.SUCCESS
    this.value_ = error || result

    if (this.mappedInto_) {
      this.constructor.scheduler.push(this)
      return
    }

    if (error) {
      this.pendingRejection_ = true
      this.constructor.scheduler.push(this)
    }
  }

  map (fun) {
    validate(isFunction, fun)

    if (!isAmbiguous(this)) {
      throw Error(`A future can only be mapped once and only if not averted`)
    }

    const mappedInto = new this.constructor()
    mappedInto.mappedFrom_ = this
    mappedInto.mapper_ = fun
    this.mappedInto_ = mappedInto
    this.consumed_ = true

    this.pendingRejection_ = false
    if (this.state !== this.states.PENDING) this.constructor.scheduler.push(this)

    return mappedInto
  }

  mapError (fun) {
    validate(isFunction, fun)
    return this.map(mapError.bind(null, fun))
  }

  mapResult (fun) {
    validate(isFunction, fun)
    return this.map(mapResult.bind(null, fun))
  }

  toPromise () {
    return (
      this.state === this.state.ERROR
      ? Promise.reject(this.value_)
      : this.state === this.state.SUCCESS
      ? Promise.resolve(this.value_)
      : new Promise(mapFutureToPromise.bind(null, this))
    )
  }

  catch () {
    return this.toPromise().catch(...arguments)
  }

  then () {
    return this.toPromise().then(...arguments)
  }

  finishPending () {
    if (this.pendingIniter_) {
      const initer = this.pendingIniter_
      this.pendingIniter_ = undefined
      try {this.deiniter_ = initer(this)}
      catch (err) {arriveWithCaughtError(this, err)}
    }

    const mappedInto = this.mappedInto_
    if (mappedInto) {
      if (this.state === this.states.ERROR) {
        unpair(this, mappedInto)
        mappedInto.arrive(this.value_)
      }
      else if (this.state === this.states.SUCCESS) {
        unpair(this, mappedInto)
        mappedInto.arrive(undefined, this.value_)
      }
    }

    if (this.pendingRejection_) {
      this.pendingRejection_ = false
      if (this.state === this.states.ERROR) {
        this.constructor.handleRejection(this)
      }
    }
  }

  deinit () {
    this.pendingIniter_ = undefined
    this.pendingRejection_ = false
    this.mapper_ = undefined

    if (this.state !== this.states.AVERTED) {
      this.state = this.states.AVERTED

      try {
        const deiniter = this.deiniter_
        this.deiniter_ = undefined
        if (deiniter) deiniter()
      }
      finally {
        try {
          const mappedFrom = this.mappedFrom_
          this.mappedFrom_ = undefined
          if (mappedFrom) mappedFrom.deinit()
        }
        finally {
          try {
            const mappedInto = this.mappedInto_
            this.mappedInto_ = undefined
            if (mappedInto) mappedInto.deinit()
          }
          finally {
            const waitingFor = this.waitingFor_
            this.waitingFor_ = undefined
            if (waitingFor) waitingFor.deinit()
          }
        }
      }
    }
  }

  static init (initer) {
    validate(isFunction, initer)
    const future = new this()
    try {future.deiniter_ = initer(future)}
    catch (err) {arriveWithCaughtError(future, err)}
    return future
  }

  static initAsync (initer) {
    validate(isFunction, initer)
    const future = new this()
    future.pendingIniter_ = initer
    this.scheduler.push(future)
    return future
  }

  static from (error, result) {
    const future = new this()
    future.arrive(error, result)
    return future
  }

  static fromError (error) {
    validate(Boolean, error)
    return isAmbiguousFuture(error) ? error : this.from(error)
  }

  static fromResult (result) {
    return isAmbiguousFuture(result) ? result : this.from(undefined, result)
  }

  static all (values) {
    validateEach(isConsumable, values)

    if (!values.length) return this.fromResult([])

    const joined = new this()

    const results = Array(values.length)

    const pendingFutures = values.map(function initPending (value, index) {
      const pending = this.fromResult(value).map(function mapToJoined (error, result) {
        pull(pendingFutures, pending)
        if (error) {
          try {joined.arrive(error)}
          finally {deinitPending()}
        }
        else {
          results[index] = result
          if (!pendingFutures.length) joined.arrive(null, results)
        }
      })
      return pending
    }, this)

    function deinitPending () {
      flushBy(pendingFutures, deinit)
    }

    joined.deiniter_ = deinitPending

    return joined
  }

  static race (values) {
    validateEach(isConsumable, values)

    const joined = new this()

    const pendingFutures = values.map(function initPending (value) {
      const pending = this.fromResult(value).map(function mapToRace (error, result) {
        pull(pendingFutures, pending)
        try {joined.arrive(error, result)}
        finally {deinitPending()}
      })
      return pending
    }, this)

    function deinitPending () {
      flushBy(pendingFutures, deinit)
    }

    joined.deiniter_ = deinitPending

    return joined
  }

  // User-overridable
  static handleRejection (future) {
    throw future.value_
  }
}

Future.prototype.states = {
  PENDING: 'PENDING',
  ERROR: 'ERROR',
  SUCCESS: 'SUCCESS',
  AVERTED: 'AVERTED',
}

Future.scheduler = new Scheduler()

exports.Future = Future

/**
 * Utils
 */

function mapError (fun, error, result) {
  return error ? fun(error) : result
}

function mapResult (fun, error, result) {
  if (error) throw error
  return fun(result)
}

function arriveAtMappedError (future, error, result) {
  future.waitingFor_ = undefined
  future.arrive(error || result)
}

function arriveAtMappedResult (future, error, result) {
  future.waitingFor_ = undefined
  future.arrive(error, result)
}

function arriveWithCaughtError (future, err) {
  if (future.state === future.states.PENDING) {
    future.arrive(err)
  }
  else {
    throw err
  }
}

function unpair (parent, child) {
  parent.mappedInto_ = undefined
  child.mappedFrom_ = undefined
}

function mapFutureToPromise (future, resolve, reject) {
  future.map(function finalizeFuturePromise (error, result) {
    if (error) reject(error)
    else resolve(result)
  })
}

function isAmbiguous (future) {
  return future.state !== future.states.AVERTED && !future.consumed_
}

function isAmbiguousFuture (value) {
  return isFuture(value) && isAmbiguous(value)
}

function isConsumable (value) {
  return !isFuture(value) || isAmbiguous(value)
}

function isDeinitable (value) {
  return Boolean(value) && isFunction(value.deinit)
}

function deinit (value) {
  if (isDeinitable(value)) value.deinit()
}

function flushBy (values, fun, a, b, c) {
  validate(isFunction, fun)
  validate(isArray, values)
  try {
    while (values.length) {
      fun(values.pop(), a, b, c)
    }
  }
  catch (err) {
    flushBy(values, fun, a, b, c)
    throw err
  }
}

function pull (array, value) {
  validate(isArray, array)
  const index = array.indexOf(value)
  if (~index) array.splice(index, 1)  // eslint-disable-line no-bitwise
  return array
}

function isFunction (value) {
  return typeof value === 'function'
}

function isArray (value) {
  return value instanceof Array
}

function validate (test, value) {
  if (!test(value)) throw Error(`Expected ${value} to satisfy test ${test.name}`)
}

function validateEach (test, array) {
  validate(isArray, array)
  for (let i = -1; ++i < array.length;) {
    if (!test(array[i])) {
      throw Error(`Expected ${array[i]} at index ${i} to satisfy test ${test.name}`)
    }
  }
}

/* eslint-disable no-restricted-globals */
function chooseAsapImplementation (fun) {
  if (typeof self === 'undefined' && typeof process === 'object' && process && process.nextTick) {
    return process.nextTick
  }
  if (typeof MessageChannel === 'function') {
    const channel = new MessageChannel()
    channel.port1.onmessage = fun
    return function asap () {channel.port2.postMessage(null)}
  }
  return setTimeout
}
/* eslint-enable no-restricted-globals */
