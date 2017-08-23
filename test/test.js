'use strict'

const chai = require('chai')
chai.use(require('chai-as-promised'))
const {expect} = chai
const {isFuture, Future} = require('../')

/**
 * Utils
 */

process.on('unhandledRejection', (error, _promise) => {
  console.error('Unhandled promise rejection:', error)
  process.exit(1)
})

class MockError extends Error {get name () {return this.constructor.name}}

function runAsync (fun) {
  return new Promise((resolve, reject) => {
    setImmediate(() => {
      try {resolve(fun())}
      catch (err) {reject(err)}
    })
  })
}

function cancelableDelay (time, fun, ...args) {
  return clearTimeout.bind(null, setTimeout(fun, time, ...args))
}

// Not using Promise.race because it would keep the test-running process alive
// for the duration of the timeout, even after it loses the race.
function race (fun, onTimeout) {
  const cancel = cancelableDelay(500, onTimeout)
  return new Promise(resolve => {
    fun(function finishRace (value) {
      cancel()
      resolve(value)
    })
  })
}

// Execution starts sequentially, but may still overlap in duration
function seq (asyncFuns) {
  return asyncFuns.reduce(followUp, Promise.resolve())
}

function followUp (promise, asyncFun) {
  return promise.then(noop).then(asyncFun)
}

function noop () {}

function id (value) {return value}

// This should prevent reactor ticks from happening "too soon", before we get a
// chance to intercept pending operations in tests. If reactor uses
// `setImmediate` or `process.nextTick`, it breaks tests.
Future.scheduler.asap = setTimeout

/**
 * Tests
 */

seq([
  async function test_isFuture () {
    expect(new Future()).to.satisfy(isFuture)
  },


  async function test_settle_with_error_sync () {
    const future = new Future()
    future.settle(new MockError('<error>'), '<unused result>')
    expect(future.deref.bind(future)).to.throw(MockError)
  },


  async function test_settle_with_result_sync () {
    const future = new Future()
    const result = '<result>'
    future.settle(null, result)
    expect(future.deref()).to.equal(result)
  },


  async function test_deinit_settle_with_error_sync () {
    const future = new Future()
    future.deinit()
    future.settle(new MockError(`this must not be thrown: the future is deinited`))
  },


  async function test_settle_error_warns_unhandled () {
    const future = new Future()
    future.settle(new MockError('<error>'), '<unused result>')
    const {handleRejection} = Future
    try {
      const [rejectedFuture] = await race(
        resolve => {
          Future.handleRejection = rejectedFuture => {
            resolve([rejectedFuture])
          }
        },
        () => {throw Error('timed out')}
      )
      expect(rejectedFuture).to.equal(future)
    }
    finally {
      Future.handleRejection = handleRejection
    }
  },


  async function test_settle_with_error_async () {
    const future = new Future()

    expect(future.deref()).to.equal(undefined)

    await runAsync(() => {
      future.settle(new MockError('<async error>'), '<unused result>')
    })

    expect(future.deref.bind(future)).to.throw(MockError)
  },


  async function test_settle_with_result_async () {
    const future = new Future()
    const result = '<async result>'

    expect(future.deref()).to.equal(undefined)

    await runAsync(() => {
      future.settle(null, result)
    })

    expect(future.deref()).to.equal(result)
  },


  async function test_from_error () {
    const future0 = Future.from(new MockError('<sync error>'), '<unused result>')
    expect(future0.deref.bind(future0)).to.throw(MockError)

    const future1 = Future.fromError(new MockError('<sync error>'))
    expect(future1.deref.bind(future1)).to.throw(MockError)
  },


  async function test_from_error_nested () {
    const result = '<result>'
    const future = Future.fromError(Future.fromResult(result))
    const value = await race(
      resolve => future.mapError(resolve),
      () => {throw Error('timed out')}
    )
    expect(value).to.equal(result)
  },


  async function test_from_result () {
    const result = '<result>'
    expect(Future.from(null, result).deref()).to.equal(result)
    expect(Future.fromResult(result).deref()).to.equal(result)
  },


  async function test_from_result_nested () {
    const result = '<result>'
    const future = Future.fromResult(Future.fromResult(result))
    const value = await race(
      resolve => future.mapResult(resolve),
      () => {throw Error('timed out')}
    )
    expect(value).to.equal(result)
  },


  async function test_from_error_deinit () {
    // Must cancel "unhandled rejection"
    Future.from(new MockError('<error>')).deinit()
  },


  async function test_from_promise_ok () {
    const result = '<value>'
    const future = Future.fromPromise(Promise.resolve(result))
    const value = await race(
      resolve => future.mapResult(resolve),
      () => {throw Error('timed out')}
    )
    expect(value).to.equal(result)
    expect(future.deref()).to.equal(result)
  },


  async function test_from_promise_fail () {
    const future = Future.fromPromise(Promise.reject(new MockError('<error>')))
    const error = await race(
      resolve => future.mapError(resolve),
      () => {throw Error('timed out')}
    )
    expect(error).to.be.instanceof(MockError)
  },


  async function test_init_error_sync () {
    const future = Future.init(future => {
      future.settle(new MockError('<error>'))
    })
    expect(future.deref.bind(future)).to.throw(MockError)
  },


  async function test_init_exception_sync () {
    const future = Future.init(() => {
      throw new MockError('<exception>')
    })
    expect(future.deref.bind(future)).to.throw(MockError)
  },


  async function test_init_result_sync () {
    const result = '<async result>'
    const future = Future.init(future => {
      future.settle(null, result)
    })
    expect(future.deref()).to.equal(result)
  },


  // Await until initialisation is complete to avoid bleeding unhandled
  // rejections into other tests.
  // Race against timeout prevents accidental failure to resolve the promises,
  // which causes the entire test to quietly stop if we're awaiting on them,
  // at least in my current version of Node.js (v7.7.1).
  async function test_init_async () {
    await race(
      resolve => {
        Future.init(async future => {
          await runAsync(() => future.settle(new MockError('<async error>')))
          expect(future.deref.bind(future)).to.throw(MockError)
          resolve()
        })
      },
      () => {throw Error('timed out waiting for async init')}
    )

    await race(
      resolve => {
        Future.init(async future => {
          const result = '<async result>'
          await runAsync(() => future.settle(null, result))
          expect(future.deref()).to.equal(result)
          resolve()
        })
      },
      () => {throw Error('timed out waiting for async init')}
    )
  },


  async function test_initAsync_with_exception_and_tick () {
    const future = Future.initAsync(() => {
      throw new MockError('<init exception>')
    })

    expect(future.deref()).to.equal(undefined)

    expect(future.finishPending.bind(future)).to.throw(MockError)

    future.finishPending()

    expect(future.deref.bind(future)).to.throw(MockError)
  },

  async function test_initAsync_with_result () {
    const result = '<async result>'

    const [future] = await race(
      resolve => Future.initAsync(future => {
        future.settle(null, result)
        resolve([future])
      }),
      () => {throw Error('timed out')}
    )

    expect(future.deref()).to.equal(result)
  },


  async function test_init_deinit () {
    Future.init(() => (
      cancelableDelay(0, () => {
        console.error(new MockError(`must not be thrown`))
        process.exit(1)
      })
    )).deinit()
  },


  async function test_initAsync_deinit () {
    Future.initAsync(() => (
      cancelableDelay(0, () => {
        console.error(new MockError(`must not be thrown`))
        process.exit(1)
      })
    )).deinit()
  },


  async function test_map_over_from_error () {
    const mapped = Future.fromError(new MockError('one'))
      .map((error, _result) => {throw new MockError(`${error.message} two`)})
      .mapError(error => {throw error})
      .mapError(error => Future.fromError(error))
      .mapError(error => Future.fromResult(`${error.message} three`))
      .mapResult(result => result)
      .mapResult(result => Future.fromResult(result))
      .mapResult(result => Future.fromError(new MockError(`${result} four`)))

    expect(mapped.deref()).to.equal(undefined)

    const error = await race(
      resolve => mapped.mapError(resolve),
      () => {throw Error('timed out')}
    )

    expect(error).to.be.instanceof(MockError)
    expect(error.message).to.equal('one two three four')
  },


  async function test_map_over_from_result () {
    const root = Future.fromResult('one')

    const mapped = root
      .map((_error, result) => {throw new MockError(`${result} two`)})
      .mapError(error => {throw error})
      .mapError(error => Future.fromError(error))
      .mapError(error => Future.fromResult(`${error.message} three`))
      .mapResult(result => result)
      .mapResult(result => Future.fromResult(result))
      .mapResult(result => Future.fromResult(`${result} four`))
      .mapResult(result => Future.initAsync(future => future.settle(null, result)))

    expect(mapped.deref()).to.equal(undefined)

    const result = await race(
      resolve => mapped.mapResult(resolve),
      () => {throw Error('timed out')}
    )

    expect(result).to.equal('one two three four')
  },


  async function test_map_pending_followed_by_sync_error () {
    const root = new Future()

    const mapped = root
      .map((error, _result) => {throw new MockError(`${error.message} two`)})
      .mapError(error => {throw error})
      .mapError(error => Future.fromError(error))
      .mapError(error => Future.fromResult(`${error.message} three`))
      .mapResult(result => result)
      .mapResult(result => Future.fromResult(result))
      .mapResult(result => Future.fromError(new MockError(`${result} four`)))
      .mapResult(result => Future.initAsync(future => future.settle(null, result)))

    root.settle(new MockError('one'))

    expect(mapped.deref()).to.equal(undefined)

    const error = await race(
      resolve => mapped.mapError(resolve),
      () => {throw Error('timed out')}
    )

    expect(error).to.be.instanceof(MockError)
    expect(error.message).to.equal('one two three four')
  },


  async function test_map_pending_followed_by_sync_result () {
    const root = new Future()

    const mapped = root
      .map((_error, result) => {throw new MockError(`${result} two`)})
      .mapError(error => {throw error})
      .mapError(error => Future.fromError(error))
      .mapError(error => Future.fromResult(`${error.message} three`))
      .mapResult(result => result)
      .mapResult(result => Future.fromResult(result))
      .mapResult(result => Future.fromResult(`${result} four`))
      .mapResult(result => Future.initAsync(future => future.settle(null, result)))

    expect(mapped.deref()).to.equal(undefined)

    root.settle(null, 'one')

    const result = await race(
      resolve => mapped.mapResult(resolve),
      () => {throw Error('timed out')}
    )

    expect(result).to.equal('one two three four')
  },


  async function test_map_exception_async () {
    const mapped = Future.initAsync(future => {future.settle(new MockError('one'))})
      .map((error, _result) => {throw new MockError(`${error.message} two`)})
      .mapError(error => {throw error})
      .mapError(error => Future.fromError(error))
      .mapError(error => Future.fromResult(`${error.message} three`))
      .mapResult(result => result)
      .mapResult(result => Future.fromResult(result))
      .mapResult(result => Future.initAsync(() => {throw new MockError(`${result} four`)}))

    const error = await race(
      resolve => mapped.mapError(resolve),
      () => {throw Error('timed out')}
    )

    expect(error).to.be.instanceof(MockError)
    expect(error.message).to.equal('one two three four')
  },


  async function test_map_result_async () {
    const mapped = Future.initAsync(future => {future.settle(new MockError('one'))})
      .map((error, _result) => {throw new MockError(`${error.message} two`)})
      .mapError(error => {throw error})
      .mapError(error => Future.fromError(error))
      .mapError(error => `${error.message} three`)
      .mapResult(result => result)
      .mapResult(result => Future.fromResult(result))
      .mapResult(result => `${result} four`)

    const result = await race(
      resolve => mapped.mapResult(resolve),
      () => {throw Error('timed out')}
    )

    expect(result).to.equal('one two three four')
  },


  async function test_map_error_skips_results () {
    const mapped = Future.fromError(new MockError('one'))
      .mapResult(result => `${result} two`)
      .mapResult(result => `${result} three`)
      .mapError(error => `${error.message} four`)

    const result = await race(
      resolve => mapped.mapResult(resolve),
      () => {throw Error('timed out')}
    )

    expect(result).to.equal('one four')
  },


  async function test_map_deinit_semi_async_parent () {
    Future.init(() => (
      cancelableDelay(0, () => {
        console.error(new MockError(`must not be thrown`))
        process.exit(1)
      })
    )).map(error => {throw error})
      .mapError(error => {throw error})
      .mapError(error => Future.initAsync(future => future.settle(error)))
      .mapResult(noop)
      .deinit()
  },


  async function test_map_deinit_async_parent () {
    Future.initAsync(() => {
      console.error(new MockError(`must not be thrown`))
      process.exit(1)
    }).map(error => {throw error})
      .mapError(error => {throw error})
      .mapResult(noop)
      .deinit()
  },


  async function test_map_deinit_semi_async_inner () {
    Future.fromResult()
      .map(() => Future.init(() => (
        cancelableDelay(0, () => {
          console.error(new MockError(`must not be thrown`))
          process.exit(1)
        })
      )))
      .mapError(error => {throw error})
      .mapResult(noop)
      .deinit()
  },


  async function test_map_deinit_async_child () {
    Future.fromResult()
      .map(() => Future.initAsync(() => {
        console.error(new MockError(`must not be thrown`))
        process.exit(1)
      }))
      .mapError(error => {throw error})
      .mapResult(noop)
      .deinit()
  },


  async function test_map_is_unavailable_after_deinit () {
    const future = new Future()
    future.deinit()
    expect(future.map.bind(future, noop)).to.throw(Error, `averted`)
  },


  async function map_consumes_future_and_can_only_be_called_once () {
    const future = new Future()
    future.map(noop)
    expect(future.map.bind(future, noop)).to.throw(Error, `mapped`)
  },


  async function map_averts_unhandled_rejection () {
    const future = Future.fromError(new MockError('should be handled automatically'))
    future.map(noop)
  },


  async function test_nested_settle_sync () {
    const message = '<nested error>'
    const future = new Future()
    future.settle(Future.fromResult(Future.fromError(new MockError(message))))

    const error = await race(
      resolve => future.mapError(resolve),
      () => {throw Error('timed out')}
    )

    expect(error).to.be.instanceof(MockError)
    expect(error.message).to.equal(message)
  },


  async function test_nested_settle_async () {
    const future = new Future()

    future.settle(Future.initAsync(future => {
      future.settle(null, Future.fromResult(Future.fromError(new MockError('<error>'))))
    }))

    const error = await race(
      resolve => future.mapError(resolve),
      () => {throw Error('timed out')}
    )

    expect(error).to.be.instanceof(MockError)
  },


  async function test_nested_settle_result_as_error_sync () {
    const future = new Future()

    future.settle(Future.fromResult(new MockError('<error>')))

    const error = await race(
      resolve => future.mapError(resolve),
      () => {throw Error('timed out')}
    )

    expect(error).to.be.instanceof(MockError)
  },


  async function test_nested_settle_error_as_result_sync () {
    const future = new Future()

    future.settle(null, Future.fromError(new MockError('<error>')))

    const error = await race(
      resolve => future.mapError(resolve),
      () => {throw Error('timed out')}
    )

    expect(error).to.be.instanceof(MockError)
  },


  async function test_nested_settle_result_as_error_async () {
    const future = new Future()

    future.settle(Future.initAsync(future => {
      future.settle(null, Future.fromResult(new MockError('<error>')))
    }))

    const error = await race(
      resolve => future.mapError(resolve),
      () => {throw Error('timed out')}
    )

    expect(error).to.be.instanceof(MockError)
  },


  async function test_nested_settle_deinit () {
    Future.fromResult(Future.fromError(Future.init(() => (
      cancelableDelay(0, () => {
        console.error(new MockError(`must not be thrown`))
        process.exit(1)
      })
    )))).deinit()
  },


  async function test_nested_settle_with_self () {
    const future = new Future()
    expect(future.settle.bind(future, null, future)).to.throw()
  },


  async function test_nested_settle_with_sync_error_and_result () {
    const future = new Future()
    future.settle(new MockError('<error>'), Future.fromResult('<result>'))
    expect(future.deref.bind(future)).to.throw(MockError)
  },


  async function test_nested_settle_with_future_error_and_future_result () {
    const future = new Future()

    future.settle(
      Future.fromError(new MockError('<error>')),
      Future.fromResult('<unused result>')
    )

    const error = await race(
      resolve => future.mapError(resolve),
      () => {throw Error('timed out')}
    )

    expect(error).to.be.instanceof(MockError)
  },


  async function test_to_promise () {
    expect(new Future().toPromise()).to.be.instanceof(Promise)
  },


  async function test_promise_catch () {
    const future = new Future()
    await runAsync(() => future.settle(new MockError('<promise error>')))
    expect(future.toPromise()).to.be.rejectedWith(MockError)
    expect(Future.from(new MockError('fail')).toPromise()).to.be.rejectedWith(MockError)
  },


  async function test_promise_then () {
    const future = new Future()
    const result = '<promise result>'
    await runAsync(() => future.settle(null, result))
    expect(Future.from(null, result).toPromise()).to.become(result)
  },


  async function test_direct_catch () {
    // Calling `.catch()` directly because chai-as-promised might use `.then(a, b)`
    expect(Future.from(new MockError('fail')).catch(id)).to.eventually.be.instanceof(MockError)
  },


  async function test_direct_then () {
    expect(Future.from(null, '<async result>')).to.eventually.equal('<async result>')
  },


  async function test_map_to_promise () {
    expect(Future.from().map(() => '<mapped>')).to.eventually.equal('<mapped>')
  },


  async function test_all_empty () {
    const joined = Future.all([])

    const result = await race(
      resolve => joined.mapResult(resolve),
      () => {throw Error('timed out')}
    )

    expect(result).to.deep.equal([])
  },


  async function test_all_from_sync_errors () {
    const joined = Future.all([
      Future.fromError(new MockError('<error one>')),
      Future.fromError(new MockError('<error two>')),
    ])

    const error = await race(
      resolve => joined.mapError(resolve),
      () => {throw Error('timed out')}
    )

    expect(error).to.be.instanceof(MockError)
    expect(error.message).to.equal('<error one>')
  },


  async function test_all_from_sync_results () {
    const joined = Future.all(['one', Future.fromResult('two')])

    const result = await race(
      resolve => joined.mapResult(resolve),
      () => {throw Error('timed out')}
    )

    expect(result).to.deep.equal(['one', 'two'])
  },


  async function test_all_from_sync_plain_results () {
    const joined = Future.all(['one', 'two'])

    const result = await race(
      resolve => joined.mapResult(resolve),
      () => {throw Error('timed out')}
    )

    expect(result).to.deep.equal(['one', 'two'])
  },


  async function test_all_from_sync_mixed () {
    const joined = Future.all([
      'one',
      Future.fromResult('two'),
      Future.fromError(new MockError('three')),
    ])

    const error = await race(
      resolve => joined.mapError(resolve),
      () => {throw Error('timed out')}
    )

    expect(error).to.be.instanceof(MockError)
    expect(error.message).to.equal('three')
  },


  async function test_all_from_sync_with_async_error () {
    const joined = Future.all([
      'one',
      Future.initAsync(future => future.settle(new MockError('three'))),
    ])

    const error = await race(
      resolve => joined.mapError(resolve),
      () => {throw Error('timed out')}
    )

    expect(error).to.be.instanceof(MockError)
    expect(error.message).to.equal('three')
  },


  async function test_all_from_sync_with_async_mapped_results () {
    const joined = Future.all([
      'one',
      Future.initAsync(future => future.settle(null, 'two')),
      Future.initAsync(future => future.settle(null, 'three')).mapResult(id),
    ])

    const result = await race(
      resolve => joined.mapResult(resolve),
      () => {throw Error('timed out')}
    )

    expect(result).to.deep.equal(['one', 'two', 'three'])
  },


  async function test_all_deinits_joined_futures () {
    Future.all([
      Future.init(() => cancelableDelay(0, () => {
        console.error(new MockError(`must not be thrown`))
        process.exit(1)
      })),
      Future.init(() => cancelableDelay(0, () => {
        console.error(new MockError(`must not be thrown`))
        process.exit(1)
      })),
    ]).deinit()
  },


  async function test_all_deinits_pending_futures_on_error () {
    const message = '<error>'

    const joined = Future.all([
      Future.init(() => cancelableDelay(0, () => {
        console.error(new MockError(`must not be thrown`))
        process.exit(1)
      })),
      Future.init(() => cancelableDelay(0, () => {
        console.error(new MockError(`must not be thrown`))
        process.exit(1)
      })).mapResult(id).mapError(id),
      Future.fromError(new MockError(message)),
    ])

    const error = await race(
      resolve => joined.mapError(resolve),
      () => {throw Error('timed out')}
    )

    expect(error).to.be.instanceof(MockError)
    expect(error.message).to.equal(message)
  },


  async function test_race_empty () {
    Future.race([]).map(() => {
      console.error(new MockError(`must not be thrown`))
      process.exit(1)
    })
  },


  async function test_race_with_sync_plain_results () {
    const joined = Future.race(['one', 'two'])

    const result = await race(
      resolve => joined.mapResult(resolve),
      () => {throw Error('timed out')}
    )

    expect(result).to.equal('one')
  },


  async function test_race_with_plain_result_and_error () {
    const value = '<result>'

    const joined = Future.race([
      value,
      new MockError('<error>'),
    ])

    const result = await race(
      resolve => joined.mapResult(resolve),
      () => {throw Error('timed out')}
    )

    expect(result).to.equal(value)
  },


  async function test_race_with_sync_error_and_async_result () {
    const message = '<error>'

    const joined = Future.race([
      Future.fromError(new MockError(message)),
      Future.initAsync(future => {
        setImmediate(() => future.settle(null, '<result>'))
      }),
    ])

    const error = await race(
      resolve => joined.mapError(resolve),
      () => {throw Error('timed out')}
    )

    expect(error).to.be.instanceof(MockError)
    expect(error.message).to.equal(message)
  },


  async function test_race_with_sync_result_and_async_error () {
    const value = '<result>'

    const joined = Future.race([
      Future.fromResult(value),
      Future.initAsync(future => {
        setImmediate(() => future.settle(new MockError('<error>')))
      }),
    ])

    const result = await race(
      resolve => joined.mapResult(resolve),
      () => {throw Error('timed out')}
    )

    expect(result).to.equal(value)
  },


  async function test_race_deinits_losers_when_finished () {
    Future.race([
      Future.init(future => future.settle(null, '<result>')),
      Future.init(() => cancelableDelay(0, () => {
        console.error(new MockError(`must not be thrown`))
        process.exit(1)
      })),
      Future.init(() => cancelableDelay(0, () => {
        console.error(new MockError(`must not be thrown`))
        process.exit(1)
      })),
    ])

    const message = '<error>'

    const joined = Future.race([
      Future.init(future => future.settle(new MockError(message))),
      Future.init(() => cancelableDelay(0, () => {
        console.error(new MockError(`must not be thrown`))
        process.exit(1)
      })),
      Future.init(() => cancelableDelay(0, () => {
        console.error(new MockError(`must not be thrown`))
        process.exit(1)
      })),
    ])

    const error = await race(
      resolve => joined.mapError(resolve),
      () => {throw Error('timed out')}
    )

    expect(error).to.be.instanceof(MockError)
    expect(error.message).to.equal(message)
  },


  async function test_weak_with_error () {
    const future = new Future()

    const weakBefore = future.weak()

    future.settle(new MockError('<error>'))

    expect(future.deref.bind(future)).to.throw(MockError, '', `
      Future error remains accessible after calling .weak()
    `)

    const weakError = await race(
      resolve => weakBefore.mapError(resolve),
      () => {throw Error('timed out')}
    )

    expect(weakError).to.be.instanceof(MockError)

    const eventual = race(
      resolve => future.mapError(resolve),
      () => {throw Error('timed out')}
    )

    const weakAfter = future.weak()
    expect(weakAfter.deref.bind(weakAfter)).to.throw(MockError)

    expect(await eventual).to.be.instanceof(MockError, '', `
      .weak() can be called before and after .map() without affecting it
    `)
  },


  async function test_weak_with_result () {
    const result = '<result>'

    const future = new Future()

    const weakBefore = future.weak()

    future.settle(null, result)

    expect(future.deref()).to.equal(result, '', `
      Future value remains accessible after calling .weak()
    `)

    const weakResult = await race(
      resolve => weakBefore.mapResult(resolve),
      () => {throw Error('timed out')}
    )

    expect(weakResult).to.equal(result)

    const eventual = race(
      resolve => future.mapResult(resolve),
      () => {throw Error('timed out')}
    )

    const weakAfter = future.weak()
    expect(weakAfter.deref()).to.equal(result)

    expect(await eventual).to.equal(result, '', `
      .weak() can be called before and after .map() without affecting it
    `)
  },


  async function test_weak_deinit_before_settle () {
    const future = new Future()

    future.weak().deinit()
    future.weak().deinit()

    future.settle(new MockError('<sync error>'))
    expect(future.deref.bind(future)).to.throw(MockError)
  },


  async function test_weak_after_deinit () {
    const future = new Future()
    future.deinit()
    expect(future.weak.bind(future)).to.throw(Error, 'averted')
  },


  async function test_weaks_dont_deinit_strong () {
    const result = '<async result>'

    const future = Future.init(() => function fatalFailure () {
      console.error(new MockError(`must not be thrown`))
      process.exit(1)
    })

    future.weak().deinit()
    future.weak().deinit()

    await runAsync(() => {
      future.settle(null, result)
    })

    future.weak().deinit()
    future.weak().deinit()

    expect(future.deref()).to.equal(result)
  },


  async function test_strong_deinits_weaks () {
    const result = '<result>'

    const future = new Future()

    future.weak().map(() => {
      console.error(new MockError(`must not be thrown`))
      process.exit(1)
    })

    future.settle(null, result)

    const weakAfter = future.weak()

    future.deinit()

    const weakResult = await race(
      resolve => weakAfter.mapResult(resolve),
      () => {throw Error('timed out')}
    )

    expect(weakResult).to.equal(
      result,
      `.weak() futures created after .settle() are unaffected by .deinit()`
    )
  },
])
