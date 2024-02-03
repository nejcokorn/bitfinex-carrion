const EventEmitter = require('events');
const fetch = require('node-fetch');
const { PublicBitfinex } = require('./bitfinex');

class Trades extends EventEmitter {
	constructor(pair) {
		super();
		this.pair = pair;
		this.channel = "trades";
		this.channelId = null;
		this.url = 'https://api-pub.bitfinex.com/v2/';

		// Initialize properties
		this.trades = [];
	}

	async history(options) {

		let {
			limit,
			start,
			end,
			sort,
			store
		} = options instanceof Object ? options : {};

		try {
			let req = await fetch(`${this.url}/${this.channel}/t${this.pair}/hist?limit=${limit}&start=${start}&end=${end}&sort=${sort}`)
			let response = await req.json();
			let trades = response.map((trade) => {
				return {
					id: trade[0],
					mts: trade[1],
					amount: trade[2],
					price: trade[3]
				}
			});

			// Sort trades by id, oldest first
			trades = trades.sort((a, b) => {
				return b.id - a.id;
			});

			// Save trades to the object
			if (store) {
				this.trades = trades;
			}

			return trades;
		} catch (err) {
			console.log(err);
			throw err;
		}
	}

	async subscribe(options) {
		return new Promise(async (resolve, reject) => {

			let {
				limit
			} = options instanceof Object ? options : {};

			this.historySize = limit === undefined ? 1000 : limit;

			// Listen for events
			this.connection = await PublicBitfinex.connect();
			this.connection.on('data', (data) => {
				try {
					data = JSON.parse(data);
					if (data instanceof Array) {
						this.processData(data);
					} else if (data instanceof Object) {
						if (data.event == 'subscribed' && this.channel == data.channel && this.channelId == null && this.pair == data.pair) {
							this.channelId = data.chanId;
							resolve();
						}
					}
				} catch (error) {
					console.log(error);
					resolve(error);
				}
			});

			this.connection.on('error', (error) => {
				if (error.event == 'error' && this.channel == error.channel && this.pair == error.pair) {
					switch (error.code) {
						case 10301:
							// Duplicated subscription
							// TODO unsubscribe first
							this.channelId = error.chanId;
							resolve();
							break;
						default:
							console.log(error);
							resolve(error);
					}
				}
			});

			this.connection.on('disconnected', (error) => {
				this.channelId = null;
				this.subscribe();
			});

			// Options for subscribe event
			let subscribeOptions = {
				event: 'subscribe',
				channel: this.channel,
				symbol: `t${this.pair}`
			};

			// Get requested amount of history trades
			if (this.historySize) {
				await this.history({limit: this.historySize, store: true})
			}

			// Subscribe to the ticker
			this.connection.emit('subscribe', subscribeOptions);
		});
	}

	processData(data) {
		let channelId = data.shift();
		if (this.channelId != channelId) {
			return;
		}

		// Skip when no data is found
		if (data.length == 0) {
			return;
		}

		// Parse data
		if (data instanceof Array && data[0] instanceof Array) {
			for (let item of data[0]) {
				// Create trade object
				let trade = {
					id: item[0],
					mts: item[1],
					amount: item[2],
					price: item[3]
				}

				// Filter out existing trades
				this.trades = this.trades.filter((t) => {
					return t.id != trade.id;
				});
				// Add new trade
				this.trades.push(trade);
				// Sort trades by id, oldest first
				this.trades = this.trades.sort((a, b) => {
					return b.id - a.id;
				});
				// Remove old trades
				if (this.trades.length > this.historySize) {
					this.trades.pop();
				}
			}

			// Emit starting trades(This includes trades from the history query)
			this.emit('history', this.trades);

		} else if(data instanceof Array && data[0] == 'tu'){
			let trade = {
				id: data[1][0],
				mts: data[1][1],
				amount: data[1][2],
				price: data[1][3]
			}

			// Filter out existing trades
			this.trades = this.trades.filter((t) => {
				return t.id != trade.id;
			});
			// Add new trade
			this.trades.push(trade);
			// Sort trades by id, oldest first
			this.trades = this.trades.sort((a, b) => {
				return b.id - a.id;
			});
			// Remove old trades
			if (this.trades.length > this.historySize) {
				this.trades.pop();
			}

			// Emit only new trades data
			this.emit('change', trade);
		}
	}

	get(options) {
		let {
			buy,
			sell
		} = options instanceof Object ? options : {};

		// Return both if not filtered
		if (buy == undefined && sell == undefined) {
			buy = true;
			sell = true;
		}

		return this.trades.filter((trade) => {
			if (buy && trade.amount > 0) {
				return true;
			}
			if (sell && trade.amount < 0) {
				return true;
			}
			return false;
		});
	}
}

module.exports = {
	Trades
}
