'use strict'

const chai = require('chai')
const {expect} = chai
const {isFuture, Future} = require('../')

/**
 * Utils
 */

process.on('unhandledRejection', (error, _promise) => {
  console.error('Unhandled promise rejection:', error)
  process.exit(1)
})

class MockError extends Error {
  get name() {return this.constructor.name}
}

function shortDelay() {
  return new Promise(resolve => {setImmediate(resolve)})
}

function cancelableDelay(time, fun, ...args) {
  return clearTimeout.bind(null, setTimeout(fun, time, ...args))
}

// For testing synchronous finalization on deinit
function shortestCancelableDelay(fun, ...args) {
  let pending = true
  process.nextTick(function afterShortestDelay() {
    if (pending) {
      pending = false
      fun(...args)
    }
  })
  return function cancel() {pending = false}
}

// Not using Promise.race because it would keep the test-running process alive
// for the duration of the timeout, even after it loses the race.
function within500(fun, timeoutError) {
  return new Promise((resolve, reject) => {
    const cancel = cancelableDelay(500, reject.bind(null, timeoutError))
    fun(function finish(value) {
      cancel()
      resolve(value)
    })
  })
}

// Execution starts sequentially, but may still overlap in duration
function startSequentially(asyncFuns) {
  return asyncFuns.reduce(followUp, Promise.resolve())
}

function followUp(promise, asyncFun) {
  return promise.then(noop).then(asyncFun)
}

function noop() {}

function id(value) {return value}

const DEINIT_MESSAGE = 'DEINIT'

/**
 * Tests
 */

startSequentially([
  async function test_isFuture() {
    expect(new Future()).to.satisfy(isFuture)
  },


  async function test_settle_with_error_sync() {
    const future = new Future()
    future.settle(new MockError('<error>'), '<unused result>')
    expect(() => future.deref()).to.throw(MockError)
  },


  async function test_settle_with_result_sync() {
    const future = new Future()
    const result = '<result>'
    future.settle(null, result)
    expect(future.deref()).to.equal(result)
  },


  async function test_no_double_settle_error() {
    const future = new Future()
    future.settle(new MockError('<error>'), '<unused result>')
    future.settle(new MockError('<unused fake error>'), '<unused fake result>')
    expect(() => future.deref()).to.throw(MockError, '<error>')
  },


  async function test_no_double_settle_result() {
    const future = new Future()
    const result = '<result>'
    future.settle(null, result)
    future.settle(null, '<unused fake result>')
    expect(future.deref()).to.equal(result)
  },


  async function test_deinit_settles_with_error() {
    const future = new Future()
    future.deinit()
    expect(() => future.deref()).to.throw(Error, DEINIT_MESSAGE)
  },


  async function test_cant_settle_after_deinit() {
    const future = new Future()
    future.deinit()
    future.settle(undefined, '<unused result>')
    expect(() => future.deref()).to.throw(Error, DEINIT_MESSAGE)
    future.settle(new MockError(`this must not be thrown: the future is deinited`))
    expect(() => future.deref()).to.throw(Error, DEINIT_MESSAGE)
  },


  async function test_settle_error_warns_unhandled() {
    const future = new Future()
    future.settle(new MockError('<error>'), '<unused result>')
    const {onUnhandledRejection} = Future
    try {
      const {rejectedFuture} = await within500(
        finish => {
          Future.onUnhandledRejection = rejectedFuture => {
            finish({rejectedFuture})
          }
        },
        Error('timed out')
      )
      expect(rejectedFuture).to.equal(future)
    }
    finally {
      Future.onUnhandledRejection = onUnhandledRejection
    }
  },


  async function test_settle_with_error_async() {
    const future = new Future()
    expect(future.deref()).to.equal(undefined)
    await shortDelay()
    future.settle(new MockError('<async error>'), '<unused result>')
    expect(() => future.deref()).to.throw(MockError)
  },


  async function test_settle_with_result_async() {
    const future = new Future()
    const result = '<async result>'
    expect(future.deref()).to.equal(undefined)
    await shortDelay()
    future.settle(null, result)
    expect(future.deref()).to.equal(result)
  },


  async function test_from_error() {
    const future0 = Future.from(new MockError('<sync error>'), '<unused result>')
    expect(() => future0.deref()).to.throw(MockError)
    const future1 = Future.fromError(new MockError('<sync error>'))
    expect(() => future1.deref()).to.throw(MockError)
  },


  async function test_from_error_nested() {
    const inner = new Future()
    const outer = Future.fromError(inner)
    inner.settle(undefined, new MockError('<error>'))
    const error = await within500(
      finish => outer.mapError(finish),
      Error('timed out')
    )
    expect(error).to.be.instanceof(MockError)
  },


  async function test_from_result() {
    const result = '<result>'
    expect(Future.from(null, result).deref()).to.equal(result)
    expect(Future.fromResult(result).deref()).to.equal(result)
  },


  async function test_from_result_nested() {
    const result = '<result>'
    const future = Future.fromResult(Future.fromResult(result))
    const value = await within500(
      finish => future.mapResult(finish),
      Error('timed out')
    )
    expect(value).to.equal(result)
  },


  async function test_deinit_suppresses_unhandled_rejection() {
    Future.from(new MockError('<error>')).deinit()
  },


  async function test_map_over_from_error() {
    const descendant = Future.fromError(new MockError('one'))
      .map((error, _result) => {throw new MockError(`${error.message} two`)})
      .mapError(error => {throw error})
      .mapError(error => Future.fromError(error))
      .mapError(error => Future.fromResult(`${error.message} three`))
      .mapResult(result => result)
      .mapResult(result => Future.fromResult(result))
      .mapResult(result => Future.fromError(new MockError(`${result} four`)))

    expect(descendant.deref()).to.equal(undefined)

    const error = await within500(
      finish => descendant.mapError(finish),
      Error('timed out')
    )

    expect(error).to.be.instanceof(MockError)
    expect(error.message).to.equal('one two three four')
  },


  async function test_map_over_from_result() {
    const ancestor = Future.fromResult('one')

    const descendant = ancestor
      .map((_error, result) => {throw new MockError(`${result} two`)})
      .mapError(error => {throw error})
      .mapError(error => Future.fromError(error))
      .mapError(error => Future.fromResult(`${error.message} three`))
      .mapResult(result => result)
      .mapResult(result => Future.fromResult(result))
      .mapResult(result => Future.fromResult(`${result} four`))

    expect(descendant.deref()).to.equal(undefined)

    const result = await within500(
      finish => descendant.mapResult(finish),
      Error('timed out')
    )

    expect(result).to.equal('one two three four')
  },


  async function test_map_pending_followed_by_sync_error() {
    const ancestor = new Future()

    const descendant = ancestor
      .map((error, _result) => {throw new MockError(`${error.message} two`)})
      .mapError(error => {throw error})
      .mapError(error => Future.fromError(error))
      .mapError(error => Future.fromResult(`${error.message} three`))
      .mapResult(result => result)
      .mapResult(result => Future.fromResult(result))
      .mapResult(result => Future.fromError(new MockError(`${result} four`)))

    ancestor.settle(new MockError('one'))

    expect(descendant.deref()).to.equal(undefined)

    const error = await within500(
      finish => descendant.mapError(finish),
      Error('timed out')
    )

    expect(error).to.be.instanceof(MockError)
    expect(error.message).to.equal('one two three four')
  },


  async function test_map_pending_followed_by_sync_result() {
    const ancestor = new Future()

    const descendant = ancestor
      .map((_error, result) => {throw new MockError(`${result} two`)})
      .mapError(error => {throw error})
      .mapError(error => Future.fromError(error))
      .mapError(error => Future.fromResult(`${error.message} three`))
      .mapResult(result => result)
      .mapResult(result => Future.fromResult(result))
      .mapResult(result => Future.fromResult(`${result} four`))

    expect(descendant.deref()).to.equal(undefined)

    ancestor.settle(null, 'one')

    const result = await within500(
      finish => descendant.mapResult(finish),
      Error('timed out')
    )

    expect(result).to.equal('one two three four')
  },


  async function test_map_pending_followed_by_async_error() {
    const ancestor = new Future()
    setImmediate(() => {
      ancestor.settle(new MockError('one'))
    })

    const descendant = ancestor
      .map((error, _result) => {throw new MockError(`${error.message} two`)})
      .mapError(error => {throw error})
      .mapError(error => Future.fromError(error))
      .mapError(error => Future.fromResult(`${error.message} three`))
      .mapResult(result => result)
      .mapResult(result => Future.fromResult(result))
      .mapResult(result => {throw new MockError(`${result} four`)})

    const error = await within500(
      finish => descendant.mapError(finish),
      Error('timed out')
    )

    expect(error).to.be.instanceof(MockError)
    expect(error.message).to.equal('one two three four')
  },


  async function test_map_result_async() {
    const ancestor = new Future()
    setImmediate(() => {
      ancestor.settle(new MockError('one'))
    })

    const descendant = ancestor
      .map((error, _result) => {throw new MockError(`${error.message} two`)})
      .mapError(error => {throw error})
      .mapError(error => Future.fromError(error))
      .mapError(error => `${error.message} three`)
      .mapResult(result => result)
      .mapResult(result => Future.fromResult(result))
      .mapResult(result => `${result} four`)

    const result = await within500(
      finish => descendant.mapResult(finish),
      Error('timed out')
    )

    expect(result).to.equal('one two three four')
  },


  async function test_map_error_skips_results() {
    const descendant = Future.fromError(new MockError('one'))
      .mapResult(result => `${result} two`)
      .mapResult(result => `${result} three`)
      .mapError(error => `${error.message} four`)

    const result = await within500(
      finish => descendant.mapResult(finish),
      Error('timed out')
    )

    expect(result).to.equal('one four')
  },


  async function test_finally_error() {
    let called = false

    const descendant = Future.fromError(new MockError('<fail>'))
      .finally((err, res) => {
        called = true
        expect(err).to.be.instanceof(MockError)
        expect(res).to.equal(undefined)
      })

    const error = await within500(
      finish => descendant.mapError(finish),
      Error('timed out')
    )

    expect(error).to.be.instanceof(MockError)
    expect(called).to.equal(true, 'Expected the finaliser to be called')
  },


  async function test_finally_result() {
    let called = false
    const result = '<result>'

    const descendant = Future.fromResult(result)
      .finally((err, res) => {
        called = true
        expect(err).to.equal(undefined)
        expect(res).to.equal(result)
      })

    const res = await within500(
      finish => descendant.mapResult(finish),
      Error('timed out')
    )

    expect(res).to.equal(result)
    expect(called).to.equal(true, 'Expected the finaliser to be called')
  },


  async function test_finally_future_error() {
    const descendant = Future.fromError(new MockError('<ignored error>')).finally(() => (
      Future.fromError(new MockError('<actual error>'))
    ))

    const error = await within500(
      finish => descendant.mapError(finish),
      Error('timed out')
    )

    expect(error).to.be.instanceof(MockError)
    expect(error.message).to.equal('<actual error>')
  },


  async function test_deinit_calls_mapper_with_error() {
    const future = new Future()
    future.deinit()
    const error = await within500(
      finish => future.mapError(finish),
      Error('timed out')
    )
    expect(error).to.be.instanceof(Error)
    expect(error.message).to.equal(DEINIT_MESSAGE)
  },


  async function test_deinit_upstream_synchronously() {
    const cancel = shortestCancelableDelay(() => {
      console.error(new MockError(`must not be thrown`))
      process.exit(1)
    })

    Future.fromResult()
      .finally(cancel)
      .map(error => {throw error})
      .mapError(error => {throw error})
      .mapError(error => Future.fromError(error))
      .mapResult(result => Future.fromResult(result))
      .mapResult(noop)
      .deinit()
  },


  async function test_deinit_downstream_asynchronously() {
    const ancestor = new Future()
    const descendant = ancestor
      .map(error => {throw error})
      .mapError(error => {throw error})
      .mapError(error => Future.fromError(error))
      .mapResult(result => Future.fromResult(result))
      .mapResult(() => {
        const cancel = shortestCancelableDelay(() => {
          console.error(new MockError(`must not be thrown`))
          process.exit(1)
        })
        return Future.fromResult().finally(cancel)
      })

    ancestor.deinit()
    ancestor.settle(undefined, '<ignored result>')
    expect(descendant.deref()).to.equal(undefined)

    await await within500(
      finish => descendant.mapError(finish),
      Error('timed out')
    )
    expect(() => descendant.deref()).to.throw(Error, DEINIT_MESSAGE)
  },


  async function test_map_downstream_deinit() {
    const ancestor = new Future()
    const descendant = ancestor.mapResult(result => result)
    ancestor.deinit()
    const error = await within500(
      finish => descendant.mapError(finish),
      Error('timed out')
    )
    expect(error).to.be.instanceof(Error)
    expect(error.message).to.equal(DEINIT_MESSAGE)
  },


  async function map_consumes_future_and_can_only_be_called_once() {
    const future = new Future()
    future.map(noop)
    expect(() => future.map(noop)).to.throw(Error, `mapped`)
  },


  async function map_averts_unhandled_rejection() {
    const future = Future.fromError(new MockError('should be handled automatically'))
    future.map(noop)
  },


  async function test_nested_settle_sync() {
    const message = '<nested error>'
    const future = new Future()
    future.settle(Future.fromResult(Future.fromError(new MockError(message))))

    const error = await within500(
      finish => future.mapError(finish),
      Error('timed out')
    )

    expect(error).to.be.instanceof(MockError)
    expect(error.message).to.equal(message)
  },


  async function test_nested_settle_async() {
    const outer = new Future()
    const inner = new Future()
    setImmediate(() => {
      inner.settle(null, Future.fromResult(Future.fromError(new MockError('<error>'))))
    })
    outer.settle(inner)

    const error = await within500(
      finish => outer.mapError(finish),
      Error('timed out')
    )

    expect(error).to.be.instanceof(MockError)
  },


  async function test_nested_settle_result_as_error_sync() {
    const future = new Future()

    future.settle(Future.fromResult(new MockError('<error>')))

    const error = await within500(
      finish => future.mapError(finish),
      Error('timed out')
    )

    expect(error).to.be.instanceof(MockError)
  },


  async function test_nested_settle_error_as_result_sync() {
    const future = new Future()

    future.settle(null, Future.fromError(new MockError('<error>')))

    const error = await within500(
      finish => future.mapError(finish),
      Error('timed out')
    )

    expect(error).to.be.instanceof(MockError)
  },


  async function test_nested_settle_result_as_error_async() {
    const outer = new Future()
    const inner = new Future()
    setImmediate(() => {
      inner.settle(null, Future.fromResult(new MockError('<error>')))
    })
    outer.settle(inner)

    const error = await within500(
      finish => outer.mapError(finish),
      Error('timed out')
    )

    expect(error).to.be.instanceof(MockError)
  },


  async function test_nested_settle_deinit() {
    const cancel = shortestCancelableDelay(() => {
      console.error(new MockError(`must not be thrown`))
      process.exit(1)
    })
    const inner = Future.fromResult().finally(cancel)
    Future.fromResult(Future.fromError(inner)).deinit()
  },


  async function test_nested_settle_with_self() {
    const future = new Future()
    expect(() => future.settle(null, future)).to.throw()
  },


  async function test_nested_settle_with_sync_error_and_result() {
    const future = new Future()
    future.settle(new MockError('<error>'), Future.fromResult('<result>'))
    expect(() => future.deref()).to.throw(MockError)
  },


  async function test_nested_settle_with_future_error_and_future_result() {
    const future = new Future()

    future.settle(
      Future.fromError(new MockError('<error>')),
      Future.fromResult('<unused result>')
    )

    const error = await within500(
      finish => future.mapError(finish),
      Error('timed out')
    )

    expect(error).to.be.instanceof(MockError)
  },


  async function test_from_promise_ok() {
    const result = '<value>'
    const future = Future.fromPromise(Promise.resolve(result))
    const value = await within500(
      finish => future.mapResult(finish),
      Error('timed out')
    )
    expect(value).to.equal(result)
    expect(future.deref()).to.equal(result)
  },


  async function test_from_promise_fail() {
    const future = Future.fromPromise(Promise.reject(new MockError('<error>')))
    const error = await within500(
      finish => future.mapError(finish),
      Error('timed out')
    )
    expect(error).to.be.instanceof(MockError)
  },


  async function test_to_promise() {
    expect(new Future().toPromise()).to.be.instanceof(Promise)
  },


  async function test_to_promise_catch() {
    const future = Future.fromError(new MockError('<promise error>'))
    const error = await future.toPromise().catch(id)
    expect(error).to.be.instanceof(MockError)
  },


  async function test_promise_catch() {
    const future = Future.fromError(new MockError('<promise error>'))
    const error = await future.catch(id)
    expect(error).to.be.instanceof(MockError)
  },


  async function test_to_promise_then() {
    const result = '<promise result>'
    const eventual = await Future.fromResult(result).toPromise().then(id)
    expect(eventual).to.equal(result)
  },


  async function test_promise_then() {
    const result = '<promise result>'
    const eventual = await Future.fromResult(result).then(id)
    expect(eventual).to.equal(result)
  },


  async function test_all_empty() {
    const joined = Future.all([])

    const result = await within500(
      finish => joined.mapResult(finish),
      Error('timed out')
    )

    expect(result).to.deep.equal([])
  },


  async function test_all_from_sync_errors() {
    const joined = Future.all([
      Future.fromError(new MockError('<error one>')),
      Future.fromError(new MockError('<error two>')),
    ])

    const error = await within500(
      finish => joined.mapError(finish),
      Error('timed out')
    )

    expect(error).to.be.instanceof(MockError)
    expect(error.message).to.equal('<error one>')
  },


  async function test_all_from_sync_results() {
    const joined = Future.all(['one', Future.fromResult('two')])

    const result = await within500(
      finish => joined.mapResult(finish),
      Error('timed out')
    )

    expect(result).to.deep.equal(['one', 'two'])
  },


  async function test_all_from_sync_plain_results() {
    const joined = Future.all(['one', 'two'])

    const result = await within500(
      finish => joined.mapResult(finish),
      Error('timed out')
    )

    expect(result).to.deep.equal(['one', 'two'])
  },


  async function test_all_from_sync_mixed() {
    const joined = Future.all([
      'one',
      Future.fromResult('two'),
      Future.fromError(new MockError('three')),
    ])

    const error = await within500(
      finish => joined.mapError(finish),
      Error('timed out')
    )

    expect(error).to.be.instanceof(MockError)
    expect(error.message).to.equal('three')
  },


  async function test_all_from_sync_with_async_error() {
    const inner = new Future()
    setImmediate(() => {
      inner.settle(new MockError('three'))
    })

    const joined = Future.all(['one', inner])

    const error = await within500(
      finish => joined.mapError(finish),
      Error('timed out')
    )

    expect(error).to.be.instanceof(MockError)
    expect(error.message).to.equal('three')
  },


  async function test_all_from_sync_with_async_mapped_results() {
    const innerTwo = new Future()
    setImmediate(() => {
      innerTwo.settle(null, 'two')
    })

    const innerThree = new Future()
    setImmediate(() => {
      innerThree.settle(null, 'three')
    })

    const joined = Future.all(['one', innerTwo, innerThree.mapResult(id)])

    const result = await within500(
      finish => joined.mapResult(finish),
      Error('timed out')
    )

    expect(result).to.deep.equal(['one', 'two', 'three'])
  },


  async function test_all_deinits_joined_futures() {
    const cancelOne = shortestCancelableDelay(() => {
      console.error(new MockError(`must not be thrown`))
      process.exit(1)
    })

    const cancelTwo = shortestCancelableDelay(() => {
      console.error(new MockError(`must not be thrown`))
      process.exit(1)
    })

    const inner = Future.fromResult().finally(cancelOne)

    const joined = Future.all([
      inner,
      Future.fromResult().finally(cancelTwo),
    ])

    joined.deinit()

    await joined.map(noop)

    expect(() => inner.deref()).to.throw(Error, DEINIT_MESSAGE)
  },


  async function test_all_deinits_pending_futures_on_error() {
    const message = '<error>'

    const cancelOne = shortestCancelableDelay(() => {
      console.error(new MockError(`must not be thrown`))
      process.exit(1)
    })

    const cancelTwo = shortestCancelableDelay(() => {
      console.error(new MockError(`must not be thrown`))
      process.exit(1)
    })

    const joined = Future.all([
      Future.fromResult().finally(cancelOne),
      Future.fromResult().finally(cancelTwo).mapResult(id).mapError(id),
      Future.fromError(new MockError(message)),
    ])

    const error = await within500(
      finish => joined.mapError(finish),
      Error('timed out')
    )

    expect(error).to.be.instanceof(MockError)
    expect(error.message).to.equal(message)
  },


  async function test_race_empty() {
    const joined = Future.race([])

    const result = await within500(
      finish => joined.mapResult(finish),
      Error('timed out')
    )

    expect(result).to.equal(undefined)
  },


  async function test_race_with_sync_plain_results() {
    const joined = Future.race(['one', 'two'])

    const result = await within500(
      finish => joined.mapResult(finish),
      Error('timed out')
    )

    expect(result).to.equal('one')
  },


  async function test_race_with_plain_result_and_error() {
    const value = '<result>'

    const joined = Future.race([
      value,
      new MockError('<error>'),
    ])

    const result = await within500(
      finish => joined.mapResult(finish),
      Error('timed out')
    )

    expect(result).to.equal(value)
  },


  async function test_race_with_sync_error_and_async_result() {
    const message = '<error>'

    const inner = new Future()
    setImmediate(() => {
      inner.settle(null, '<result>')
    })

    const joined = Future.race([
      Future.fromError(new MockError(message)),
      inner,
    ])

    const error = await within500(
      finish => joined.mapError(finish),
      Error('timed out')
    )

    expect(error).to.be.instanceof(MockError)
    expect(error.message).to.equal(message)
  },


  async function test_race_with_sync_result_and_async_error() {
    const value = '<result>'

    const inner = new Future()
    setImmediate(() => {
      inner.settle(new MockError('<error>'))
    })

    const joined = Future.race([
      Future.fromResult(value),
      inner,
    ])

    const result = await within500(
      finish => joined.mapResult(finish),
      Error('timed out')
    )

    expect(result).to.equal(value)
  },


  async function test_race_deinits_losers_when_finished() {
    const cancelOne = shortestCancelableDelay(() => {
      console.error(new MockError(`must not be thrown`))
      process.exit(1)
    })

    const cancelTwo = shortestCancelableDelay(() => {
      console.error(new MockError(`must not be thrown`))
      process.exit(1)
    })

    Future.race([
      Future.fromResult('<result>'),
      Future.fromResult().finally(cancelOne),
      Future.fromResult().finally(cancelTwo),
    ])

    const message = '<error>'

    const cancelThree = shortestCancelableDelay(() => {
      console.error(new MockError(`must not be thrown`))
      process.exit(1)
    })

    const cancelFour = shortestCancelableDelay(() => {
      console.error(new MockError(`must not be thrown`))
      process.exit(1)
    })

    const joined = Future.race([
      Future.fromError(new MockError(message)),
      Future.fromResult().finally(cancelThree),
      Future.fromResult().finally(cancelFour),
    ])

    const error = await within500(
      finish => joined.mapError(finish),
      Error('timed out')
    )

    expect(error).to.be.instanceof(MockError)
    expect(error.message).to.equal(message)
  },


  async function test_weak_with_error() {
    const future = new Future()

    const weakBefore = future.weak()

    future.settle(new MockError('<error>'))

    expect(() => future.deref()).to.throw(MockError, '', `
      Future error remains accessible after calling .weak()
    `)

    const weakError = await within500(
      finish => weakBefore.mapError(finish),
      Error('timed out')
    )
    expect(weakError).to.be.instanceof(MockError)

    const eventual = within500(
      finish => future.mapError(finish),
      Error('timed out')
    )

    const weakAfter = future.weak()
    const weakErrorAfter = await within500(
      finish => weakAfter.mapError(finish),
      Error('timed out')
    )
    expect(weakErrorAfter).to.be.instanceof(MockError)

    expect(await eventual).to.be.instanceof(MockError, '', `
      .weak() can be called before and after .map() without affecting it
    `)
  },


  async function test_weak_with_result() {
    const result = '<result>'

    const future = new Future()

    const weakBefore = future.weak()

    future.settle(null, result)

    expect(future.deref()).to.equal(result, '', `
      Future value remains accessible after calling .weak()
    `)

    const weakResult = await within500(
      finish => weakBefore.mapResult(finish),
      Error('timed out')
    )
    expect(weakResult).to.equal(result)

    const eventual = within500(
      finish => future.mapResult(finish),
      Error('timed out')
    )

    const weakAfter = future.weak()
    const weakResultAfter = await within500(
      finish => weakAfter.mapResult(finish),
      Error('timed out')
    )
    expect(weakResultAfter).to.equal(result)

    expect(await eventual).to.equal(result, '', `
      .weak() can be called before and after .map() without affecting it
    `)
  },


  async function test_weak_deinit_before_settle() {
    const future = new Future()

    future.weak().deinit()
    future.weak().deinit()

    future.settle(new MockError('<sync error>'))
    expect(() => future.deref()).to.throw(MockError)
  },


  async function test_weak_after_deinit() {
    const future = new Future()
    future.deinit()

    const weak = future.weak()
    const weakError = await within500(
      finish => weak.mapError(finish),
      Error('timed out')
    )
    expect(weakError).to.be.instanceof(Error)
    expect(weakError.message).to.equal(DEINIT_MESSAGE)
  },


  async function test_weaks_dont_deinit_strong() {
    const result = '<async result>'

    const parent = new Future()

    const child = parent.finally(function fatalFailure(error, result) {
      if (!result) {
        console.error(new MockError(`must not be thrown`))
        process.exit(1)
      }
    })

    child.weak().deinit()
    child.weak().deinit()

    await shortDelay()
    parent.settle(null, result)

    const finished = await within500(
      finish => child.mapResult(finish),
      Error('timed out')
    )

    child.weak().deinit()
    child.weak().deinit()

    expect(finished).to.equal(result)
  },


  async function test_strong_deinits_weaks() {
    const future = new Future()
    future.weak().map((error, result) => {
      if (result) {
        console.error(new MockError(`must not be thrown`))
        process.exit(1)
      }
    })
    future.deinit()
    future.settle(undefined, '<ignored result>')
  },


  async function test_strong_cant_deinit_weaks_after_settling() {
    const result = '<result>'
    const future = new Future()

    const weakBefore = future.weak()

    future.settle(null, result)
    // should be a noop
    future.deinit()

    const weakResultBefore = await within500(
      finish => weakBefore.mapResult(finish),
      Error('timed out')
    )
    expect(weakResultBefore).to.equal(
      result,
      `.weak() futures created before settling are unaffected by .deinit()`
    )

    const weakAfter = future.weak()
    const weakResultAfter = await within500(
      finish => weakAfter.mapResult(finish),
      Error('timed out')
    )
    expect(weakResultAfter).to.equal(
      result,
      `.weak() futures created after settling and deiniting receive the settled result`
    )
  },


  async function test_wait_for_stray_ticks() {
    await shortDelay()
  },
])
