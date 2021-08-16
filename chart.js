/*
 * Copyright (c) 2021 - abskmj@gmail.com
 */

const apiKey = 'BQYvhnv04csZHaprIBZNwtpRiDIwEIW9' // replace this with your API Key

//=== Bitquery ===//

// get token information
const queryTokenInfo = `
query ($tokenAddress: String, $exchange: String) {
  ethereum(network: bsc) {
    dexTrades(
      options: {desc: ["block.height", "transaction.index"], limit: 1}
      exchangeName: {is: $exchange}
      baseCurrency: {is: $tokenAddress}
    ) {
      block {
        height
        timestamp {
          time(format: "%Y-%m-%d %H:%M:%S")
        }
      }
      transaction {
        index
      }
      baseCurrency {
        name
        symbol
        decimals
      }
    }
  }
}
`

// get OHLC data for a token
const queryTokenBars = `
query ($from: ISO8601DateTime!, $to: ISO8601DateTime!, $interval: Int!, $tokenAddress: String, $exchange: String) {
  ethereum(network: bsc) {
    dexTrades(
      options: {asc: "timeInterval.minute"}
      date: {since: $from, till: $to}
      exchangeName: {is: $exchange}
      baseCurrency: {is: $tokenAddress},
      quoteCurrency: {is: "0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c"},
      tradeAmountUsd: {gt: 10}
    ) {
      timeInterval {
        minute(count: $interval, format: "%Y-%m-%dT%H:%M:%SZ")
      }
      volume: quoteAmount
      high: quotePrice(calculate: maximum)
      low: quotePrice(calculate: minimum)
      open: minimum(of: block, get: quote_price)
      close: maximum(of: block, get: quote_price)
    }
  }
}
`

// get latest WBNB-BUSD price for conversion
const queryBUSDPrice = `
query {
  ethereum(network: bsc) {
    dexTrades(
      baseCurrency: {is: "0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c"}
      quoteCurrency: {is: "0xe9e7cea3dedca5984780bafc599bd69add087d56"}
      options: {desc: ["block.height", "transaction.index"], limit: 1}
    ) {
      block {
        height
        timestamp {
          time(format: "%Y-%m-%d %H:%M:%S")
        }
      }
      transaction {
        index
      }
      baseCurrency {
        symbol
      }
      quoteCurrency {
        symbol
      }
      quotePrice
    }
  }
}
`

const bitqueryClient = axios.create({
  baseURL: 'https://graphql.bitquery.io',
  headers: { 'X-API-KEY': apiKey }
})

bitqueryClient.interceptors.response.use(function (response) {
  // errors in graphql apis are part of the response body
  if (response?.data?.errors) return Promise.reject({
    message: 'Error in bitquery API, it generally happens due to their rate limit, refresh the page in some time ',
    error: response.data.errors[0]
  })
  else return response;
}, function (error) {
  // return other errors as is
  return Promise.reject(error);
});

const bitquery = {
  getTokenInfo: (exchange, token) => bitqueryClient.post(
    '/', {
    query: queryTokenInfo,
    variables: {
      tokenAddress: token,
      exchange
    }
  }),
  getBUSDPrice: () => bitqueryClient.post(
    '/', { query: queryBUSDPrice }),
  getTokenBars: (from, to, resolution, token, exchange) => bitqueryClient.post(
    '/', {
    query: queryTokenBars,
    variables: {
      from: new Date(from * 1000).toISOString(),
      to: new Date(to * 1000).toISOString(),
      interval: Number(resolution),
      tokenAddress: token,
      exchange
    }
  })
}

// cache latest BUSD price
let price;

const getBUSDPrice = async () => {
  const res = await bitquery.getBUSDPrice()
  price = res?.data?.data?.ethereum?.dexTrades?.[0]?.quotePrice

  console.log('BSUD Price:', price)
}

const convertPriceToBUSD = (wbnb) => wbnb * price


//=== Datafeed ===//

const configurationData = {
  supported_resolutions: ['1', '5', '15', '30', '60', '240', '720', '1D', '1W']
};

let timer;

const barsCache = new Map();

const datafeed = {
  onReady: async (callback) => {
    try {
      console.log('Datafeed onReady')

      await getBUSDPrice()

      callback(configurationData)
    } catch (err) {
      console.error(err)
    }
  },
  searchSymbols: (userInput, exchange, symbolType, onResultReadyCallback) => {
    console.log('Datafeed searchSymbols:', userInput, exchange, symbolType);
  },
  resolveSymbol: async (symbolName, onSymbolResolvedCallback, onResolveErrorCallback) => {
    try {
      console.log('Datafeed resolveSymbol:', symbolName)

      if (symbolName.includes(':')) {
        const [exchange, token] = symbolName.split(':')

        const response = await bitquery.getTokenInfo(exchange, token)

        console.log('Bitquery.io API response:', response)

        const tokenInfo = response?.data?.data?.ethereum?.dexTrades?.[0]?.baseCurrency

        console.log('TokenInfo:', tokenInfo)

        if (!tokenInfo) {
          onResolveErrorCallback()
        } else {
          const symbol = {
            ticker: token,
            name: `${tokenInfo.symbol}/USD`,
            // description: symbolItem.description,
            // type: symbolItem.type,
            session: '24x7',
            timezone: 'Etc/UTC',
            exchange,
            minmov: 1,
            pricescale: 10000000,
            has_intraday: true,
            intraday_multipliers: ['1', '5', '15', '30', '60', '240', '720'],
            supported_resolutions: configurationData.supported_resolutions,
            data_status: 'streaming',
          }

          console.log('Resolved Symbol:', symbol)
          onSymbolResolvedCallback(symbol)
        }
      } else onResolveErrorCallback()
    } catch (err) {
      console.error(err)
      onResolveErrorCallback()
    }
  },
  getBars: async (symbolInfo, resolution, periodParams, onHistoryCallback, onErrorCallback) => {
    try {
      console.log('Datafeed getBars:', symbolInfo, resolution, periodParams);

      const { from, to, firstDataRequest } = periodParams

      if (resolution === '1D') resolution = 1440

      const response = await bitquery.getTokenBars(from, to, resolution, symbolInfo.ticker, symbolInfo.exchange)

      console.log('Bitquery.io API response:', response)

      let bars = []

      if (response?.data?.data?.ethereum?.dexTrades?.length) {
        if (price) {

          // convert WBNB prices to BUSD
          bars = response.data.data.ethereum.dexTrades.map((el) => ({
            time: new Date(el.timeInterval.minute).getTime(), // date string in api response
            low: convertPriceToBUSD(el.low),
            high: convertPriceToBUSD(el.high),
            open: convertPriceToBUSD(Number(el.open)), // string in api response
            close: convertPriceToBUSD(Number(el.close)), // string in api response
            volume: el.volume
          }))
        }
      }

      // filter bars to be in requested range
      bars = bars.filter((bar) => bar.time > from * 1000 && bar.time <= to * 1000)

      console.log('Bars:', bars)


      if (bars.length) {
        if (firstDataRequest) barsCache.set(symbolInfo.ticker, bars[bars.length - 1])
        onHistoryCallback(bars, { noData: false })
      } else {
        onHistoryCallback(bars, { noData: true })
      }
    } catch (err) {
      console.log(err)
      onErrorCallback(err)
    }
  },
  subscribeBars: (symbolInfo, resolution, onRealtimeCallback, subscribeUID, onResetCacheNeededCallback) => {
    console.log('Datafeed subscribeBars:', symbolInfo, resolution, subscribeUID);

    const queryLatestPrice = `query ($tokenAddress: String) {
      swaps(first: 1,
        orderBy: timestamp,
        orderDirection: desc,
        where: {
          token0: $tokenAddress
          token1: "0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c"
        }) {
        timestamp
        token0 {
          symbol
          id
          name
        }
        token1 {
          symbol
          id
          name
        }
        amount0In
        amount1In
        amount0Out
        amount1Out
        amountUSD
      }
    }
    `
    const token = symbolInfo.ticker

    timer = setInterval(async () => {
      const response = await axios.post(
        'https://bsc.streamingfast.io/subgraphs/name/pancakeswap/exchange-v2', {
        query: queryLatestPrice,
        variables: {
          tokenAddress: token
        }
      })

      if (response?.data?.data?.swaps?.[0]) {
        const swap = response.data.data.swaps[0]

        console.log('Swap:', swap)

        const amount0 = Math.abs(swap.amount0In - swap.amount0Out)
        const amount1 = Math.abs(swap.amount1In - swap.amount1Out)

        const priceInWBNB = amount1 / amount0

        const priceInUSD = (swap.amountUSD / amount1) * priceInWBNB

        console.log('Prices:', priceInWBNB, priceInUSD)

        const time = Math.floor(swap.timestamp / resolution) * resolution * 1000

        const bar = barsCache.get(symbolInfo.ticker)

        console.log('timestamps:', bar.time, time)

        let newBar
        if (time > bar.time) {
          // add new bar
          newBar = {
            time,
            open: priceInUSD,
            high: priceInUSD,
            low: priceInUSD,
            close: priceInUSD,
          }

          console.log('Add:', newBar)
        } else {
          // update existing
          newBar = {
            ...bar,
            high: Math.max(bar.high, priceInUSD),
            low: Math.min(bar.low, priceInUSD),
            close: priceInUSD,
          }

          console.log('Update:', newBar)
        }

        barsCache.set(symbolInfo.ticker, newBar)

        onRealtimeCallback(newBar)
      }
    }, 10000)
  },
  unsubscribeBars: (subscriberUID) => {
    console.log('Datafeed subscribeBars:', subscriberUID);

    timer.clear()
  },
};

//=== TradingView Widget ===//

// get token from URL parameters
const { searchParams } = new URL(window.location.href)

console.log('TradingView Charts Version:', TradingView.version())

const widget = window.tvWidget = new TradingView.widget({
  fullscreen: true,
  symbol: searchParams.get('token') || 'Pancake v2:0x0e09fabb73bd3ade0a17ecc321fd13a19e81ce82',
  interval: '60',
  container: "tv_chart_container",
  datafeed,
  library_path: "charting_library/",
  locale: "en",
  disabled_features: ["use_localstorage_for_settings"],
  theme: 'Dark',
});