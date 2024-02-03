const WebSocket = require('ws');
const EventEmitter = require('events');
const crypto = require('crypto-js');
const fetch = require('node-fetch');

// Global variable used by Public class
let connections = [];

class BitfinexUtil {
	static roundPrice(price) {
		let count = 0;
		let first = false;
		return parseFloat(price.toFixed(12).toString().split('').map((char) => {
			first = first == true || (char != '.' && char != '0') ? true : false;
			count += first == true && char != '.' ? 1 : 0;
			return char != '.' ? (count <= 5 ? char : '0') : char;
		}).join(''));
	}
	
	static roundAmount(amount, percision) {
		let count = 0;
		let dot = false;
		percision = percision === undefined ? 6 : percision;
		return parseFloat(amount.toFixed(12).toString().split('').filter((char) => {
			dot = dot || char == '.' ? true : false;
			count += dot ? 1 : 0;
			return !dot || count <= percision + 1;
		}).join(''));
	}
}

class PublicBitfinex {
	static async connect() {
		return new Promise(async (resolve, reject) => {
			// After maximum allowed subscriptions open new connection
			if (connections.length && connections[connections.length - 1].subscriptions < 30) {
				connections[connections.length - 1].subscriptions++;
				resolve(connections[connections.length - 1].emitter);
			} else {
				let socket = new WebSocket('wss://api-pub.bitfinex.com/ws/2');
				let emitter = new EventEmitter();

				socket.setMaxListeners(10);
				emitter.setMaxListeners(500);

				let connection = {
					id: connections.length + 1,
					subscriptions: 1,
					socket: socket,
					emitter: emitter
				};

				// Store connection
				connections.push(connection);

				// Wait for connection to open
				socket.on('open', () => {
					clearTimeout(socket.timeout);
					socket.timeout = setTimeout(() => {
						let error = new Error("Heartbeat timeout");
						console.log(error);

						// Remove this connection
						connections = connections.filter((conn) => {
							return conn.id != connection.id;
						});

						// Close socket connection
						socket.close();

						// Notify subscribers
						return emitter.emit('disconnected', error);
					}, 45000);

					// Return with emitter
					resolve(emitter);
				});

				socket.on('message', (data) => {
					try {
						data = JSON.parse(data);
						if (data instanceof Array && data[1] == 'hb') {
							clearTimeout(socket.timeout);
							socket.timeout = setTimeout(() => {
								let error = new Error("Heartbeat timeout");
								console.log(error);

								// Remove this connection
								connections = connections.filter((conn) => {
									return conn.id != connection.id;
								});

								// Close socket connection
								socket.close();

								// Notify subscribers
								return emitter.emit('disconnected', error);
							}, 45000);

							// Prevent furthure execution
							return;
						}
						if (data instanceof Object && data.event == 'error') {
							return emitter.emit('error', data);
						}
						return emitter.emit('data', JSON.stringify(data));
					} catch (error) {
						return emitter.emit('error', error);
					}
				});

				socket.on('close', () => {
					let error = new Error("Socket closed");
					console.log(error);
					// return emitter.emit('disconnected', error);
				});

				// Pass subscription event to the socket
				emitter.on('subscribe', (data) => {
					socket.send(JSON.stringify(data));
				});
			}
		});
	}
}

class PrivateBitfinex extends EventEmitter {
	constructor(options) {
		super();

		let {
			timeout
		} = options instanceof Object ? options : {};

		this.apiKey = process.env.BITFINEX_API_KEY;
		this.apiSecret = process.env.BITFINEX_API_SECRET;

		// Snapshot counter
		this.snapshots = 0;

		this.orders = [];
		this.trades = [];
		this.wallets = [];

		// Response timeout
		this.timeout = timeout != undefined ? timeout : 30000;
	}

	async subscribe() {
		return new Promise(async (resolve, reject) => {
			// Generate an ever increasing, single use value. (a timestamp satisfies this criteria)
			this.authNonce = Date.now() * 1000;
			// Compile the authentication payload, this is simply the string 'AUTH' prepended to the nonce value
			this.authPayload = 'CARRION' + this.authNonce;
			// The authentication payload is hashed using the private key, the resulting hash is output as a hexadecimal string
			this.authSig = crypto.HmacSHA384(this.authPayload, this.apiSecret).toString(crypto.enc.Hex);

			const options = {
				apiKey: this.apiKey,
				authSig: this.authSig,
				authNonce: this.authNonce,
				authPayload: this.authPayload,
				event: 'auth',
				//dms: 4, // Optional Dead-Man-Switch flag to cancel all orders when socket is closed
				//filter: [] // Optional filter for the account info received (default = everything)
			}

			// Create Account Websocket
			this.privateSocket = new WebSocket('wss://api.bitfinex.com/ws/2');
			this.privateSocket.on('open', () => {
				this.privateSocket.send(JSON.stringify(options));
			});

			this.privateSocket.on('close', () => {
				// TODO handle this situation
			});

			this.privateSocket.on('message', (message) => {
				try {
					// Parse JSON object
					// console.log(message);
					let data = JSON.parse(message);
					if (data instanceof Array) {
						// Explode data into peaces
						let channelId = data.shift();
						let type = data.shift();
						data = data.shift();

						switch (type) {
							case `hb`:
								clearTimeout(this.privateSocket.timeout);
								this.privateSocket.timeout = setTimeout(() => {
									let error = new Error("Heartbeat timeout");
									console.log(error);

									// Reload the application process
									process.exit();
								}, 45000);
								break;
							// Balance update
							case `bu`:
								this.balanceUpdateEvent(data);
								break;
							// Funding credits snapshot
							case `fcs`:
								this.snapshots++;
								break
							// Funding loans snapshot
							case `fls`:
								this.snapshots++;
								break
							// Funding offer snapshot
							case `fos`:
								this.snapshots++;
								break
							// Notification
							case `n`:
								switch (data[1]) {
									// Order New Request
									case `on-req`:
										this.orderNewRequestEvent(data);
										break;
									// Order Update Request
									case `ou-req`:
										this.orderUpdateRequestEvent(data);
										break;
									// Order Cancel Request
									case `oc-req`:
										this.orderCancelRequestEvent(data);
										break;
									default:
										console.log(channelId, type, data);
										break;
								}
								break;
							// Order Snapshot
							case `os`:
								this.snapshots++;
								this.orderSnapshotEvent(data);
								break;
							// Order New
							case `on`:
								this.orderNewEvent(data);
								break;
							// Order Update
							case `ou`:
								this.orderUpdateEvent(data);
								break;
							// Order Cancel
							case `oc`:
								this.orderCancelEvent(data);
								break;
							// Position Snapshot
							case `ps`:
								this.snapshots++;
								break;
							// Position New
							case `pn`:
								break;
							// Position Update
							case `pu`:
								break;
							// Position Close
							case `pc`:
								break;
							// Trade Executed
							case `te`:
								this.tradeExecutedEvent(data);
								break;
							// Trade Execution Update
							case `tu`:
								this.tradeUpdateEvent(data);
								break;
							// Wallet Snapshot
							case `ws`:
								this.snapshots++;
								this.walletSnapshotEvent(data);
								break;
							// Wallet Update
							case `wu`:
								this.walletUpdateEvent(data);
								break;
							default:
								console.log(channelId, type, data);
								break;
						}
					} else if (data instanceof Object) {
						if (data.event == 'auth' && data.status != 'OK') {
							reject(data);
						} else {
							console.log("Unhandeled event");
							console.log(data);
						}
					}
				} catch (error) {
					// This is unlekly to happen
					this.emit('error', error);
				}

				if (this.snapshots == 6) {
					// Wallet has successfully loaded
					this.snapshots = 0;
					resolve();
				}
			});
		});
	}

	balanceUpdateEvent(balance) {
		console.log(`[${(new Date()).toISOString()}];Account balance;${BitfinexUtil.roundAmount(balance[0], 2)}`);
		// Sent email every morning
	}

	orderSnapshotEvent(data) {
		// Loop through array of orders
		for (var item of data) {
			// Extract symbol
			let symbol = item[3];

			// Create order object
			let order = {
				id: item[0],
				gid: item[1],
				cid: item[2],
				symbol: item[3],
				mts_create: item[4],
				mts_update: item[5],
				amount: item[6],
				amount_orig: item[7],
				order_type: item[8],
				type_prev: item[9],
				mts_tif: item[10],
				flags: item[12],
				status: item[13],
				price: item[16],
				price_avg: item[17],
				price_trailing: item[18],
				price_aux_limit: item[19],
				notify: item[23],
				hidden: item[24],
				placed_id: item[25],
				routing: item[28],
				meta: item[31]
			}

			// Remove order if order already exist
			this.orders = this.orders.filter((o) => {
				return o.id != order.id;
			});

			// Add order to the array
			this.orders.push(order);
		}
	}

	orderNewEvent(data) {
		// Extract order symbol
		let symbol = data[3];

		// Create order object
		let order = {
			id: data[0],
			gid: data[1],
			cid: data[2],
			symbol: data[3],
			mtsCreate: data[4],
			mtsUpdate: data[5],
			amount: data[6],
			amountOrig: data[7],
			orderType: data[8],
			typePrev: data[9],
			mtsTif: data[10],
			flags: data[12],
			status: data[13],
			price: data[16],
			priceAvg: data[17],
			priceTrailing: data[18],
			priceAuxLimit: data[19],
			notify: data[23],
			hidden: data[24],
			placedId: data[25],
			routing: data[28]
		}

		// Add order to the array if successfully created
		if (order.status == 'ACTIVE') {
			this.orders.push(order);
		}

		// Emit events
		this.emit(`order.new.${order.symbol}`, order);
		this.emit(`order.new.${order.symbol}.cid.${order.cid}`, order);
		this.emit(`order.new.${order.symbol}.id.${order.id}`, order);
	}

	orderNewRequestEvent(data) {
		// Extract order data
		let orderData = data[4];

		// Create order object
		let order = {
			id: orderData[0],
			gid: orderData[1],
			cid: orderData[2],
			symbol: orderData[3],
			mtsCreate: orderData[4],
			mtsUpdate: orderData[5],
			amount: orderData[6],
			amountOrig: orderData[7],
			type: orderData[8],
			typePrev: orderData[9],
			mtsTif: orderData[10],
			flags: orderData[12],
			orderStatus: orderData[13],
			price: orderData[16],
			priceAvg: orderData[17],
			priceTrailing: orderData[18],
			priceAuxLimit: orderData[19],
			hidden: orderData[23],
			placedId: orderData[24],
			routing: orderData[28],
			meta: orderData[31]
		};

		// Create notification object
		let notification = {
			mts: data[0],
			type: data[1],
			messageId: data[2],
			code: data[5],
			status: data[6],
			text: data[7],
			order: order
		}

		// Emit notification
		this.emit(`order.new.notification.${order.symbol}`, notification);
		if (order.cid) {
			this.emit(`order.new.notification.${order.symbol}.cid.${order.cid}`, notification);
		}
		this.emit(`order.new.notification.${order.symbol}.id.${order.id}`, notification);
	}

	async orderOpen(options) {
		return new Promise(async (resolve, reject) => {
			// Extract options properties
			let {
				gid,
				type,
				symbol,
				amount,
				price,
				// lev,
				// price_trailing,
				// price_aux_limit,
				// price_oco_stop,
				flags,
				// tif,
				// meta
			} = options instanceof Object ? options : {};

			// TODO add data validation

			// Set cid based on current timestamp
			let cid = Date.now();

			// Calculate flag value
			let flagValue = 0;
			if (flags) {
				flagValue += flags && flags.hidden ? 64 : 0
				flagValue += flags && flags.close ? 512 : 0
				flagValue += flags && flags.reduceOnly ? 1024 : 0
				flagValue += flags && flags.postOnly ? 4096 : 0
				flagValue += flags && flags.oneCancelOther ? 16384 : 0
				flagValue += flags && flags.oneCancelOther ? 16384 : 0
			}

			// Return once order gets created
			this.once(`order.new.${symbol}.cid.${cid}`, (order) => {
				resolve(order);
			});

			// Check for errors
			this.once(`order.new.notification.${symbol}.cid.${cid}`, (notification) => {
				if (notification.status == 'ERROR') {
					let err = new Error(notification.text);
					reject(err);
				}
			});

			// Set timeout in case there is no response from the server
			setTimeout(() => {
				let err = new Error(`Order Open Timeout. symbol: ${symbol}, cid: ${cid}`);
				reject(err);
			}, this.timeout);

			// Create new order
			this.privateSocket.send(JSON.stringify([
				0,
				"on",
				null,
				{
					gid: gid,
					cid: cid,
					type: type,
					symbol: symbol,
					amount: `${amount}`,
					price: price ? `${price}` : undefined,
					flags: flags ? flagValue : undefined
				}
			]));
		});
	}

	orderUpdateEvent(data) {
		// Extract order symbol
		let symbol = data[3];

		// Create order object
		let order = {
			id: data[0],
			gid: data[1],
			cid: data[2],
			symbol: data[3],
			mtsCreate: data[4],
			mtsUpdate: data[5],
			amount: data[6],
			amountOrig: data[7],
			orderType: data[8],
			typePrev: data[9],
			mtsTif: data[10],
			flags: data[12],
			status: data[13],
			price: data[16],
			priceAvg: data[17],
			priceTrailing: data[18],
			priceAuxLimit: data[19],
			notify: data[23],
			hidden: data[24],
			placedId: data[25],
			routing: data[28]
		}

		// Remove existing order
		this.orders = this.orders.filter((item) => {
			return order.id != item.id;
		});

		// Add order to the array
		this.orders.push(order);

		this.emit(`order.update.${order.symbol}`, order);
		this.emit(`order.update.${order.symbol}.cid.${order.cid}`, order);
		this.emit(`order.update.${order.symbol}.id.${order.id}`, order);
	}

	orderUpdateRequestEvent(data) {
		// Extract order data
		let orderData = data[4];

		// Create order object
		let order = {
			id: orderData[0],
			gid: orderData[1],
			cid: orderData[2],
			symbol: orderData[3],
			mtsCreate: orderData[4],
			mtsUpdate: orderData[5],
			amount: orderData[6],
			amountOrig: orderData[7],
			type: orderData[8],
			typePrev: orderData[9],
			mtsTif: orderData[10],
			flags: orderData[12],
			orderStatus: orderData[13],
			price: orderData[16],
			priceAvg: orderData[17],
			priceTrailing: orderData[18],
			priceAuxLimit: orderData[19],
			hidden: orderData[23],
			placedId: orderData[24],
			routing: orderData[28],
			meta: orderData[31]
		};

		// Create notification object
		let notification = {
			mts: data[0],
			type: data[1],
			messageId: data[2],
			code: data[5],
			status: data[6],
			text: data[7],
			order: order
		}

		// Emit notification
		this.emit(`order.update.notification.${order.symbol}`, notification);
		if (order.cid) {
			this.emit(`order.update.notification.${order.symbol}.cid.${order.cid}`, notification);
		}
		this.emit(`order.update.notification.${order.symbol}.id.${order.id}`, notification);
	}

	async orderUpdate(options) {
		return new Promise(async (resolve, reject) => {
			// Extract options properties
			let {
				cid,
				id,
				symbol,
				amount,
				price,
				flags
			} = options instanceof Object ? options : {};

			// Calculate flag value
			let flagValue = 0;
			if (flags) {
				flagValue += flags && flags.hidden ? 64 : 0
				flagValue += flags && flags.close ? 512 : 0
				flagValue += flags && flags.reduceOnly ? 1024 : 0
				flagValue += flags && flags.postOnly ? 4096 : 0
				flagValue += flags && flags.oneCancelOther ? 16384 : 0
				flagValue += flags && flags.oneCancelOther ? 16384 : 0
			}

			// Return once order gets updated tracked by id
			if (id) {
				this.once(`order.update.${symbol}.id.${id}`, (order) => {
					resolve(order);
				});

				// Check for errors
				this.once(`order.update.notification.${symbol}.id.${id}`, (notification) => {
					if (notification.status == 'ERROR') {
						console.log(notification);
						let err = new Error(notification.text);
						reject(err);
					}
				});
			}

			// Return once order gets updated tracked by cid
			if (cid) {
				this.once(`order.update.${symbol}.cid.${cid}`, (order) => {
					resolve(order);
				});

				// Check for errors
				this.once(`order.update.notification.${symbol}.cid.${cid}`, (notification) => {
					if (notification.status == 'ERROR') {
						let err = new Error(notification.text);
						reject(err);
					}
				});
			}

			// Set timeout in case there is no response from the server
			setTimeout(() => {
				let err = new Error(`Order Update Timeout. symbol: ${symbol}, id: ${id}, cid: ${cid}`);
				reject(err);
			}, this.timeout);

			// Create new order
			this.privateSocket.send(JSON.stringify([
				0,
				"ou",
				null,
				{
					id: id,
					cid: cid,
					amount: amount ? `${amount}` : undefined,
					price: price ? `${price}` : undefined,
					flags: flags ? flagValue : undefined
				}
			]));
		});
	}

	orderCancelEvent(data) {
		// Extract order symbol
		let symbol = data[3];

		// Get order
		let order = this.orders.find((item) => {
			return data[0] == item.id;
		});

		// Remove existing order
		this.orders = this.orders.filter((item) => {
			return data[0] != item.id;
		});

		if (order) {
			this.emit(`order.cancel.${order.symbol}`, order);
			this.emit(`order.cancel.${order.symbol}.id.${order.id}`, order);
		}
	}

	orderCancelRequestEvent(data) {
		// Extract order data
		let orderData = data[4];

		// Create order object
		let order = {
			id: orderData[0],
			gid: orderData[1],
			cid: orderData[2],
			symbol: orderData[3],
			mtsCreate: orderData[4],
			mtsUpdate: orderData[5],
			amount: orderData[6],
			amountOrig: orderData[7],
			type: orderData[8],
			typePrev: orderData[9],
			mtsTif: orderData[10],
			flags: orderData[12],
			orderStatus: orderData[13],
			price: orderData[16],
			priceAvg: orderData[17],
			priceTrailing: orderData[18],
			priceAuxLimit: orderData[19],
			hidden: orderData[23],
			placedId: orderData[24],
			routing: orderData[28],
			meta: orderData[31]
		};

		// Create notification object
		let notification = {
			mts: data[0],
			type: data[1],
			messageId: data[2],
			code: data[5],
			status: data[6],
			text: data[7],
			order: order
		}

		// Emit notification
		this.emit(`order.cancel.notification.${order.symbol}`, notification);
		if (order.cid) {
			this.emit(`order.cancel.notification.${order.symbol}.cid.${order.cid}`, notification);
		}
		this.emit(`order.cancel.notification.${order.symbol}.id.${order.id}`, notification);
	}

	async orderCancel(options) {
		return new Promise(async (resolve, reject) => {
			// Extract options properties
			let {
				id,
				cid,
				symbol
			} = options instanceof Object ? options : {};

			// Return once order gets canceled tracked by id
			if (id) {
				this.once(`order.cancel.${symbol}.id.${id}`, (order) => {
					resolve(order);
				});

				// Check for errors
				this.once(`order.cancel.notification.${symbol}.id.${id}`, (notification) => {
					if (notification.status == 'ERROR') {
						let err = new Error(notification.text);
						reject(err);
					}
				});
			}

			// Return once order gets canceled tracked by cid
			if (cid) {
				this.once(`order.cancel.${symbol}.cid.${cid}`, (order) => {
					resolve(order);
				});

				// Check for errors
				this.once(`order.cancel.notification.${symbol}.cid.${cid}`, (notification) => {
					if (notification.status == 'ERROR') {
						let err = new Error(notification.text);
						reject(err);
					}
				});
			}

			// Set timeout in case there is no response from the server
			setTimeout(() => {
				let err = new Error(`Order Cancel Timeout. symbol: ${symbol}, id: ${id}`);
				reject(err);
			}, this.timeout);

			// Cancel existing order
			this.privateSocket.send(JSON.stringify([
				0,
				"oc",
				null,
				{
					id: id
				}
			]));
		});
	}

	async tradeHistory(options) {
		return new Promise(async (resolve, reject) => {
			// Extract options properties
			let {
				pair,
				limit
			} = options instanceof Object ? options : {};

			let apiPath = `v2/auth/r/trades/t${pair}/hist`;
			let nonce = (Date.now() * 1000).toString();
			let body = {
				limit: limit
			};

			let signature = `/api/${apiPath}${nonce}${JSON.stringify(body)}`
			let sig = crypto.HmacSHA384(signature, this.apiSecret).toString();

			fetch(`https://api.bitfinex.com/${apiPath}`, {
				method: 'POST',
				body: JSON.stringify(body),
				headers: {
					'Content-Type': 'application/json',
					'bfx-nonce': nonce,
					'bfx-apikey': this.apiKey,
					'bfx-signature': sig
				}
			})
			.then(res => res.json())
			.then((data) => {
				for (var item of data) {
					this.tradeUpdateEvent(item);
				}
				resolve(data);
			}).catch((err) => {
				reject(err);
			});
		});
	}

	tradeExecutedEvent(data) {
		// Extract symbol
		let symbol = data[1];

		// Remove existing trade if it exist
		this.trades = this.trades.filter((trade) => {
			return data[0] != trade.id;
		});

		// Create object from array
		let trade = {
			id: data[0],
			symbol: data[1],
			mtsCreate: data[2],
			orderId: data[3],
			execAmount: data[4],
			execPrice: data[5],
			orderType: data[6],
			orderPrice: data[7],
			maker: data[8],
			cid: data[11]
		}

		// Add to the list of trades
		this.trades.unshift(trade);

		// Sort trades
		this.trades.sort((a, b) => {
			return b.id - a.id;
		});

		// Trigger event
		this.emit(`trade.executed`, trade);
		this.emit(`trade.executed.${symbol}`, trade);
	}

	tradeUpdateEvent(data) {
		// Extract trade symbol
		let symbol = data[1];

		// Remove existing trade if it exist
		this.trades = this.trades.filter((trade) => {
			return data[0] != trade.id;
		});

		// Create object from array
		let trade = {
			id: data[0],
			symbol: data[1],
			mtsCreate: data[2],
			orderId: data[3],
			execAmount: data[4],
			execPrice: data[5],
			orderType: data[6],
			orderPrice: data[7],
			maker: data[8],
			fee: data[9],
			feeCurrency: data[10],
			cid: data[11]
		}

		// Add to the list of trades
		this.trades.unshift(trade);

		// Sort trades
		this.trades.sort((a, b) => {
			return b.id - a.id;
		});

		// Trigger event
		this.emit(`trade.update`, trade);
		this.emit(`trade.update.${symbol}`, trade);
	}

	walletSnapshotEvent(data) {
		for (var item of data) {
			// Extract wallet type
			let type = item[0];
			// Extract wallet currency
			let currency = item[1];

			// Remove existing wallet information
			this.wallets = this.wallets.filter((wallet) => {
				return wallet.type != type || wallet.currency != currency;
			});

			// Create wallet object
			let wallet = {
				type: item[0],
				currency: item[1],
				balance: item[2],
				unsettledInterest: item[3],
				balanceAvailable: item[4],
				description: null,
				meta: null,
			};

			// Add wallet to the stack
			this.wallets.push(wallet);

			this.emit(`wallet.update`, wallet);
			this.emit(`wallet.update.${currency}`, wallet);
		}
	}

	walletUpdateEvent(data) {
		// Extract wallet type
		let type = data[0];
		// Extract wallet currency
		let currency = data[1];

		// Remove existing wallet information
		this.wallets = this.wallets.filter((wallet) => {
			return wallet.type != type || wallet.currency != currency;
		});

		// Create wallet object
		let wallet = {
			type: data[0],
			currency: data[1],
			balance: data[2],
			unsettledInterest: data[3],
			balanceAvailable: data[4],
			description: data[5],
			meta: data[6]
		};

		// Add wallet to the stack
		this.wallets.push(wallet);

		this.emit(`wallet.update`, wallet);
		this.emit(`wallet.update.${currency}`, wallet);
	}

	getOrders(options) {
		let {
			symbol,
			buy,
			sell
		} = options instanceof Object ? options : {};

		// Return both buy/sell if not filtered
		if (buy == undefined && sell == undefined) {
			buy = true;
			sell = true;
		}

		return this.orders.filter((order) => {
			if (order.symbol == symbol) {
				if (buy && order.amount > 0) {
					return true;
				}
				if (sell && order.amount < 0) {
					return true;
				}
			}
			return false;
		});
	}

	getTrades(options) {
		let {
			symbol,
			buy,
			sell
		} = options instanceof Object ? options : {};

		// Return both buy/sell trades if not filtered
		if (buy == undefined && sell == undefined) {
			buy = true;
			sell = true;
		}

		return this.trades.filter((trade) => {
			if (trade.symbol == symbol) {
				if (buy && trade.execAmount > 0) {
					return true;
				}
				if (sell && trade.execAmount < 0) {
					return true;
				}
			}
			return false;
		});
	}

	getWallet(options) {
		let {
			type,
			currency
		} = options instanceof Object ? options : {};

		return this.wallets.find((wallet) => {
			return wallet.type == type && wallet.currency == currency;
		});
	}
}

module.exports = {
	PublicBitfinex,
	PrivateBitfinex,
	BitfinexUtil
}
