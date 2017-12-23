'use strict'

const BigNumber = require('bignumber.js')
const healthStatus = require('../common/health.js')
// This simple backend uses a fixed (large) source amount and a rate to generate
// the destination amount for the curve.
const PROBE_AMOUNT = new BigNumber(10).pow(14) // stays within 15 max digits for BigNumber from Number

/**
 * Backend which charges no spread and trades everything one-to-one.
 */
class OneToOneBackend {
  /**
   * Constructor.
   *
   * @param {Integer} opts.spread The spread we will use to mark up the FX rates
   */
  constructor (opts) {
    if (!opts) {
      opts = {}
    }

    this.spread = opts.spread || 0
    this.getInfo = opts.getInfo
    this.getBalance = opts.getBalance
  }

  /**
   * Nothing to do since this backend is totally static.
   */
  async connect (mockData) {
  }

  /**
   * Get backend status
   */
  async getStatus () {
    return {
      backendStatus: healthStatus.statusOk
    }
  }

  /**
   * Get a liquidity curve for the given parameters.
   *
   * @param {String} params.sourceAccount The URI of the source ledger
   * @param {String} params.destinationAccount The URI of the destination ledger
   * @param {String} params.sourceCurrency The source currency
   * @param {String} params.destinationCurrency The destination currency
   * @returns {Promise.<Object>}
   */
  async getCurve (params) {
    const sourceInfo = this.getInfo(params.sourceAccount)
    const destinationInfo = this.getInfo(params.destinationAccount)

    const scaleDiff = destinationInfo.currencyScale - sourceInfo.currencyScale
    // The spread is subtracted from the rate when going in either direction,
    // so that the DestinationAmount always ends up being slightly less than
    // the (equivalent) SourceAmount -- regardless of which of the 2 is fixed:
    //
    //   SourceAmount * (1 - Spread) = DestinationAmount
    //
    const rate = new BigNumber(1).minus(this.spread).shift(scaleDiff)

    let limit
    if (sourceInfo.maxBalance !== undefined) {
      let balanceIn = await this.getBalance(params.sourceAccount)
      let maxAmountIn = new BigNumber(sourceInfo.maxBalance).minus(balanceIn)
      limit = [ maxAmountIn.toString(), maxAmountIn.times(rate).toString() ]
    }
    if (destinationInfo.minBalance !== undefined) {
      let balanceOut = await this.getBalance(params.destinationAccount)
      let maxAmountOut = new BigNumber(balanceOut).minus(destinationInfo.minBalance)
      if (limit === undefined || maxAmountOut.lessThan(limit[1])) {
        limit = [ maxAmountOut.div(rate).toString(), maxAmountOut.toString() ]
      }
    }

    if (limit) {
      if (limit[1] === 0) { // the route exists in theory, but the connector is either at max source balance or at min destination balance
        return { points: [] }
      }
      // avoid repeating non-increasing [0, 0], [0, 0], ...
      return limit[0] === '0'
        ? { points: [ [0, 0], [ PROBE_AMOUNT, limit[1] ] ] }
        : { points: [ [0, 0], limit ] }
    // Make sure that neither amount exceeds 15 significant digits.
    } else if (rate.gt(1)) {
      return { points: [ [0, 0], [ PROBE_AMOUNT / rate, PROBE_AMOUNT ] ] }
    } else {
      return { points: [ [0, 0], [ PROBE_AMOUNT, PROBE_AMOUNT * rate ] ] }
    }
  }

  /**
   * Dummy function because we're not actually going
   * to submit the payment to any real backend, we're
   * just going to execute it on the accounts we're connected to
   *
   * @param {String} params.sourceAccount The URI of the source ledger
   * @param {String} params.destinationAccount The URI of the destination ledger
   * @param {String} params.sourceAmount The amount of the source asset we want to send
   * @param {String} params.destinationAmount The amount of the destination asset we want to send
   * @return {Promise.<null>}
   */
  submitPayment (params) {
    return Promise.resolve(null)
  }
}

module.exports = OneToOneBackend
