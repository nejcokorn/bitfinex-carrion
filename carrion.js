const { Book } = require('./book');
const { Ticker } = require('./ticker');
const { Trades } = require('./trades');
const { Pairs } = require('./pairs');
const { PrivateBitfinex, BitfinexUtil } = require('./bitfinex');

var account = null;

class Carrion {

	constructor(options) {
		let {
			pair,
			buy,
			sell,
			mainCurrency,
			cryptoCurrency,
			strategies
		} = options instanceof Object ? options : {};

		this.pair = pair;
		this.buy = buy ? true : false;
		this.sell = sell ? true : false;
		this.mainCurrency = mainCurrency;
		this.cryptoCurrency = cryptoCurrency;
		this.strategies = strategies;
	}

	async init(options) {

		let {
			amount,
			target
		} = options instanceof Object ? options : {};

		this.book = new Book(this.pair);
		this.trades = new Trades(this.pair);
		this.ticker = new Ticker(this.pair);

		// Link/Create account object
		if (account == null) {
			account = new PrivateBitfinex({ timeout: 10000 });
			await account.subscribe();
		}

		// Get information on the pair
		let pairs = await Pairs.info();
		this.info = pairs[this.pair];

		// this.book.on(`change`, () => {
		// });
		//
		// this.trades.on(`change`, () => {
		// });
		//
		// this.ticker.on(`change`, () => {
		// });
		//
		// account.on(`trade.executed.${this.pair}`, () => {
		// });
		//
		// account.on(`wallet.update.${this.mainCurrency}`, () => {
		// });
		//
		// account.on(`wallet.update.${this.cryptoCurrency}`, () => {
		// });

		await account.tradeHistory({ pair: this.pair, limit: 200 });
		// // Get my trades
		// let myTrades = account.getTrades({ symbol: `t${this.pair}` });
		//
		// let saldo = 0;
		// for (var trade of myTrades) {
		// 	console.log(`${this.pair} ${trade.execAmount * trade.execPrice} ${trade.execAmount} ${trade.fee}`);
		// 	saldo += trade.execAmount + trade.fee;
		// }
		// console.log(myTradesBuy);

		// await this.book.subscribe();
		await this.trades.subscribe();
		await this.ticker.subscribe();

		// Start trading
		setImmediate(() => {
			this.trade();
		});
	}

	async trade(options) {
		// Loop through strategies
		for (var i = 0; i < this.strategies.length; i++) {
			// Fork strategy
			let strategy = JSON.parse(JSON.stringify(this.strategies[i]));

			// Make sure amount and maxAmount are at list of the size of minOrderSize
			// TODO set coefficient on minOrderSize instead of amount and maxAmount
			strategy.amount = strategy.amount < this.info.minOrderSize * 1.05 ? this.info.minOrderSize * 1.05 : strategy.amount;
			strategy.maxAmount = strategy.maxAmount < this.info.minOrderSize ? this.info.minOrderSize : strategy.maxAmount;

			// Select strategy
			switch (strategy.type) {
				case 'spread':
					while (true) {
						await this.strategySpread(strategy);
						await new Promise(r => setTimeout(r, 100));
					}
					break;
				case 'balance':
					while (true) {
						await this.strategyBalance(strategy)
						await new Promise(r => setTimeout(r, 100));
					}
					break;
			}
		}
	}

	async strategySpread(strategy) {
		// Force update each minute
		if (this.previousMinute != (new Date()).getMinutes()) {
			strategy.forceUpdate = true;
			this.previousMinute = (new Date()).getMinutes();
		} else {
			strategy.forceUpdate = false;
		}

		// Get wallets for this pair
		let mainWallet = account.getWallet({ type: 'exchange', currency: this.mainCurrency });
		let cryptoWallet = account.getWallet({ type: 'exchange', currency: this.cryptoCurrency });

		// Get current balance for this pair
		let mainAmount = mainWallet ? mainWallet.balance : 0;
		let cryptoAmount = cryptoWallet ? cryptoWallet.balance : 0;

		// Round holdings to 6 decimals
		mainAmount = BitfinexUtil.roundAmount(mainAmount)
		cryptoAmount = BitfinexUtil.roundAmount(cryptoAmount);

		// Get last sell order
		let tradesBuy = this.trades.get({ buy: true });
		let tradesSell = this.trades.get({ sell: true });

		// Quit if there is no history on trades
		if (!tradesBuy.length || !tradesSell.length) {
			let error = new Error(`${this.pair} Missing trades history`);
			console.log(error);
			return;
		}

		// Quit if ticker holds no information
		if (this.ticker.bid == null || this.ticker.ask == null) {
			let error = new Error(`${this.pair} Missing ticker information`);
			console.log(error);
			return;
		}

		// Get current orders
		let ordersBuy = account.getOrders({ symbol: `t${this.pair}`, buy: true });
		let ordersSell = account.getOrders({ symbol: `t${this.pair}`, sell: true });

		// Get best prices from last trades
		let lastTradeBuyPrice = Math.max(...tradesBuy.slice(0, strategy.lookupDepth).map((trade) => {
			return trade.price;
		}));
		let lastTradeSellPrice = Math.min(...tradesSell.slice(0, strategy.lookupDepth).map((trade) => {
			return trade.price;
		}));

		// Get my trades
		let myTradesBuy = account.getTrades({ symbol: `t${this.pair}`, buy: true });
		let myTradesSell = account.getTrades({ symbol: `t${this.pair}`, sell: true });

		// Get my last trade
		let myLastTradeBuy = myTradesBuy.length ? myTradesBuy[0] : null;
		let myLastTradeSell = myTradesSell.length ? myTradesSell[0] : null;

		// Check if last trade was mine
		let isLastBuyMy = myLastTradeBuy && tradesSell[0].id == myLastTradeBuy.id ? true : false;
		let isLastSellMy = myLastTradeSell && tradesBuy[0].id == myLastTradeSell.id ? true : false;

		// Calc spread based on the book as well as previous trades
		let spread = ((Math.min(lastTradeBuyPrice, this.ticker.ask) - Math.max(lastTradeSellPrice, this.ticker.bid)) / this.ticker.bid) * 100;
		// Spread in currency
		let spreadCurrency = Math.min(lastTradeBuyPrice, this.ticker.ask) - Math.max(lastTradeSellPrice, this.ticker.bid);

		let desiredBuy = null;
		let desiredSell = null;

		// Calculate buy price
		if (isLastBuyMy) {
			// Between the book and the trade
			desiredBuy = this.ticker.bid + ((lastTradeSellPrice - this.ticker.bid) / 2)
			desiredBuy = this.ticker.bid > desiredBuy ? this.ticker.bid + spreadCurrency * strategy.offset : desiredBuy;
		} else {
			// Last trade + strategy offset
			desiredBuy = lastTradeSellPrice + spreadCurrency * strategy.offset;
			desiredBuy = this.ticker.bid > desiredBuy ? this.ticker.bid + spreadCurrency * strategy.offset : desiredBuy;
		}

		// Calculate sell price
		if (isLastSellMy) {
			// Between the book and the trade
			desiredSell = this.ticker.ask - ((this.ticker.ask - lastTradeBuyPrice) / 2)
			desiredSell = this.ticker.ask < desiredSell ? this.ticker.ask - spreadCurrency * strategy.offset : desiredSell;
		} else {
			// Last trade + strategy offset
			desiredSell = lastTradeBuyPrice - spreadCurrency * strategy.offset;
			desiredSell = this.ticker.ask < desiredSell ? this.ticker.ask - spreadCurrency * strategy.offset : desiredSell;
		}

		// Correct buy price with minimum spread
		desiredBuy = desiredBuy > (desiredSell - desiredSell * (strategy.minSpread/100)) ? desiredSell - desiredSell * (strategy.minSpread/100) : desiredBuy;

		// Round prices for orders
		desiredBuy = Number(BitfinexUtil.roundPrice(desiredBuy));
		desiredSell = Number(BitfinexUtil.roundPrice(desiredSell));

		let status = {
			pair: this.pair,
			ordersBuy: ordersBuy.length,
			ordersSell: ordersSell.length,
			buy: this.buy,
			sell: this.sell,
			spread: spread,
			spreadCurrency: spreadCurrency,
			isLastBuyMy: isLastBuyMy,
			isLastSellMy: isLastSellMy,
			cryptoAmount: cryptoAmount,
			maxAmount: strategy.maxAmount,
			lastTradeSellPrice: lastTradeSellPrice,
			lastTradeBuyPrice: lastTradeBuyPrice,
			desiredBuy: desiredBuy,
			desiredSell: desiredSell,
			bid: this.ticker.bid,
			ask: this.ticker.ask
		}
		// console.log(`Status ${this.pair} ${JSON.stringify(status)}`);
		// console.log(status);

		// Close partially executed buy orders
		if (ordersBuy.length && /(PARTIALLY FILLED)/.test(ordersBuy[0].status)) {
			try {
				console.log(`Order close ${this.pair} ${ordersBuy[0].price} ${ordersBuy[0].amount}`);
				await account.orderCancel(ordersBuy[0]);
			} catch (err) {
				console.log(err);
			}
		}

		// Close partially executed sell orders
		if (ordersSell.length && cryptoAmount > this.info.minOrderSize && /(PARTIALLY FILLED)/.test(ordersSell[0].status)) {
			try {
				console.log(`Order close ${this.pair} ${ordersSell[0].price} ${ordersSell[0].amount}`);
				await account.orderCancel(ordersSell[0]);
			} catch (err) {
				console.log(err);
			}
		}

		// Buy orders
		if (!ordersBuy.length) {
			// Open new order
			if (this.buy && cryptoAmount < strategy.maxAmount) {
				try {
					console.log(`Order open ${this.pair} ${desiredBuy} ${strategy.amount}`);
					await account.orderOpen({
						type: 'EXCHANGE LIMIT',
						symbol: `t${this.pair}`,
						amount: strategy.amount,
						price: desiredBuy,
						flags: {
							// hidden: desiredBuy > this.ticker.bid ? true : false
							hidden: true
						}
					});
				} catch (err) {
					console.log(err);
				}
			}
		} else {
			// Update existing order
			if (ordersBuy[0].price != desiredBuy) {
				try {
					if (!strategy.forceUpdate && Math.abs((ordersBuy[0].price / desiredBuy) - 1) < 0.001) {
						// Skip updating if price hasn't changed much
					} else {
						console.log(`Order update ${this.pair} ${desiredBuy} ${ordersBuy[0].price} ${ordersBuy[0].amount}`);
						await account.orderUpdate({
							id: ordersBuy[0].id,
							symbol: `t${this.pair}`,
							price: desiredBuy,
							flags: {
								// hidden: desiredBuy > this.ticker.bid ? true : false
								hidden: true
							}
						});
					}

				} catch (err) {
					console.log(err);
				}
			}
		}

		// Sell orders
		if (!ordersSell.length) {
			// Open new order
			if (this.sell && cryptoAmount >= this.info.minOrderSize) {
				try {
					console.log(`Order open ${this.pair} ${desiredSell} ${cryptoAmount * -1}`);
					await account.orderOpen({
						type: 'EXCHANGE LIMIT',
						symbol: `t${this.pair}`,
						amount: cryptoAmount * -1,
						price: desiredSell,
						flags: {
							// hidden: desiredSell < this.ticker.ask ? true : false
							hidden: true
						}
					});
				} catch (err) {
					console.log(err);
				}
			}
		} else {
			// Update existing order
			if ((ordersSell[0].price != desiredSell || `${ordersSell[0].amount}` != `${cryptoAmount}`)) {
				try {
					if ((ordersSell[0].price == desiredSell || (!strategy.forceUpdate && Math.abs((ordersSell[0].price / desiredSell) - 1) < 0.001)) && (cryptoAmount < this.info.minOrderSize || ordersSell[0].amount == cryptoAmount * -1)) {
						// Price is the same or it hasn't change much and the amount has changed but is lower than the minimum order size or amout hasn't changed
					} else {
						console.log(`Order update ${this.pair} ${desiredSell} ${ordersSell[0].price} ${cryptoAmount * -1} ${ordersSell[0].amount}`);
						await account.orderUpdate({
							id: ordersSell[0].id,
							symbol: `t${this.pair}`,
							amount: cryptoAmount >= this.info.minOrderSize ? cryptoAmount * -1 : undefined,
							price: desiredSell,
							flags: {
								// hidden: desiredSell < this.ticker.ask ? true : false
								hidden: true
							}
						});
					}
				} catch (err) {
					console.log(err);
				}
			}
		}
	}

	async strategyBalance(strategy) {
		// Get wallets for this pair
		let mainWallet = account.getWallet({ type: 'exchange', currency: this.mainCurrency });
		let cryptoWallet = account.getWallet({ type: 'exchange', currency: this.cryptoCurrency });

		// Get current balance for this pair
		let mainAmount = mainWallet ? mainWallet.balance : 0;
		let cryptoAmount = cryptoWallet ? cryptoWallet.balance : 0;

		if (this.buy && cryptoAmount < strategy.minAmount) {
			// Set amount based on the current wallet status
			let amountBuy = BitfinexUtil.roundAmount((strategy.minAmount - cryptoAmount) + this.info.minOrderSize);
			console.log(`Order open ${this.pair} MARKET ${amountBuy}`);
			// Open new order
			await account.orderOpen({
				type: 'EXCHANGE MARKET',
				symbol: `t${this.pair}`,
				amount: amountBuy
			});
		} else if (this.sell && cryptoAmount > strategy.maxAmount) {
			// Set amount based on the current wallet status
			let amountSell = BitfinexUtil.roundAmount((cryptoAmount - strategy.maxAmount) + this.info.minOrderSize);
			console.log(`Order open ${this.pair} MARKET ${amountSell * -1}`);
			// Open new order
			await account.orderOpen({
				type: 'EXCHANGE MARKET',
				symbol: `t${this.pair}`,
				amount: amountSell * -1
			});
		}
	}
}

module.exports = {
	Carrion
}
