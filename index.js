const { InstanceBase, Regex, runEntrypoint, InstanceStatus, UDPHelper } = require('@companion-module/base')
const dgram = require('dgram')
const UpgradeScripts = require('./upgrades')
const UpdateActions = require('./actions')
const GetFeedbacks = require('./feedbacks')
const GetPresets = require('./presets')
const CHOICES = require('./choices')
const { clear } = require('console')

class SonyVISCAInstance extends InstanceBase {
	constructor(internal) {
		super(internal)
	}

	duplexUDP = false
	queue = []
	queueTimeout = undefined
	clearToSend = true

	clearQueueTimer() {
		clearTimeout(this.queueTimeout)
		this.clearToSend = true
		this.log('info', 'clearQueueTimer')
		console.log('clearQueueTimer')
		this.processQueue()
	}

	processQueue() {
		if (this.clearToSend) {
			if (this.queue.length > 0) {
				this.clearToSend = false
				// this.log('debug', JSON.stringify(processQueue))
				const item = this.queue.shift()
				this.VISCA.send(item.payload, item.type)
				this.queueTimeout = setTimeout(() => {
					this.clearQueueTimer()
					this.log('warn', 'Queue timer expired')
				}, 40)
			}
		}
	}

	async init(config) {
		this.config = config
		this.data = { exposureMode: 'Auto' }
		this.updateStatus(InstanceStatus.Disconnected)

		this.send = (payload, type = this.VISCA.command) => {
			this.queue.push({ payload: payload, type: type })
			this.processQueue()
		}

		this.VISCA = {
			// VISCA Communication Types
			command: Buffer.from([0x01, 0x00]),
			control: Buffer.from([0x02, 0x00]),
			inquiry: Buffer.from([0x01, 0x10]),

			send: (payload, type = this.VISCA.command) => {
				const buffer = Buffer.alloc(32)
				type.copy(buffer)

				this.packet_counter = (this.packet_counter + 1) % 0xffffffff

				buffer.writeUInt16BE(payload.length, 2)
				buffer.writeUInt32BE(this.packet_counter, 4)

				if (typeof payload == 'string') {
					buffer.write(payload, 8, 'binary')
				} else if (typeof payload == 'object' && payload instanceof Buffer) {
					payload.copy(buffer, 8)
				}

				const newBuffer = buffer.slice(0, 8 + payload.length)
				this.log('info', 'VISCA send: ' + this.viscaToString(newBuffer))
				this.timeSent = Date.now()
				this.udp.send(newBuffer, 0, payload.length + 8, parseInt(this.config.port), this.config.host, (err) => {
					if (err) {
						this.log('error', 'UDP send error: ' + err.message)
					}
				})
			},
		}

		this.ptSpeed = '0C'
		this.updateFeedbacks()
		this.updateActions() // export actions
		this.updatePresets()
		this.init_udp()
	}

	// When module gets deleted
	async destroy() {
		if (this.udp) {
			this.udp.removeAllListeners()
			this.udp.close()
			delete this.udp
		}
		this.updateStatus(InstanceStatus.Disconnected)
	}

	async configUpdated(config) {
		this.config = config
		this.init_udp()
	}

	// Return config fields for web config
	getConfigFields() {
		return [
			{
				type: 'static-text',
				id: 'info',
				width: 12,
				label: 'Information',
				value: 'This module controls PTZ cameras with VISCA over IP protocol',
			},
			{
				type: 'textinput',
				id: 'host',
				label: 'Target IP',
				width: 6,
				regex: Regex.IP,
			},
			{
				type: 'textinput',
				id: 'port',
				label: 'Target Port',
				width: 6,
				regex: Regex.PORT,
				default: '52381',
			},
			{
				type: 'dropdown',
				id: 'id',
				label: 'camera id',
				width: 6,
				default: '128',
				choices: CHOICES.CAMERA_ID,
			},
		]
	}

	updateFeedbacks() {
		this.setFeedbackDefinitions(GetFeedbacks(this))
	}

	updateActions() {
		UpdateActions(this)
	}

	updatePresets() {
		this.setPresetDefinitions(GetPresets(this))
	}

	viscaToString(payload) {
		let response = payload.toString('hex')

		let s = response.substr(0, 2)
		for (let i = 2; i < response.length; i = i + 2) {
			if (i == 4 || i == 8 || i == 16) {
				s += ' | '
			} else {
				s += ' '
			}
			s += response.substr(i, 2)
		}
		return s
	}

	logResponse(msg, rinfo) {
		const t = ` (${Date.now() - this.timeSent}ms)`
		let response = this.viscaToString(msg)
		// this.log('debug', rinfo.address + ':' + rinfo.port + ' sent: ' + response)

		if (msg[0] == 0x02 && msg[1] == 0x01) {
			// VISCA Control Packet:
			if (msg[3] == 0x01 && msg[8] == 0x01) {
				this.log('info', 'VISCA Control Reply: ACK' + t)
				this.clearQueueTimer()
				this.updateStatus(InstanceStatus.Ok)
			} else if (msg[8] == 0x0f) {
				this.log('error', 'VISCA Control ERROR: ' + msg.slice(8).toString('hex'))
			} else {
				this.log('warn', 'VISCA Control Reply: Unknown' + response)
			}
		} else if (msg[0] == 0x01 && msg[1] == 0x11) {
			if (msg[3] == 0x03) {
				// VISCA Reply |  len  |     seq     | payload
				//       01 11 | 00 03 | 00 00 00 01 | y0 4z ff  = ACK
				//       01 11 | 00 03 | 00 00 00 02 | y0 5z ff  = Complete
				// y = camera id + 8 (locked to 9 for VISCA over IP), z = socket number
				if ((msg[8] & 0xf) == 0x0 && msg[9] >> 4 == 0x4 && msg[10] == 0xff) {
					this.log('info', 'VISCA Command Reply: ACK' + t)
					this.clearQueueTimer()
					this.updateStatus(InstanceStatus.Ok)
				} else if ((msg[8] & 0xf) == 0x0 && msg[9] >> 4 == 0x5 && msg[10] == 0xff) {
					this.log('info', 'VISCA Command Reply: Complete' + t)
				}
			} else if (msg[3] == 0x04) {
				//       01 11 | 00 04 | 00 00 00 03 | y0 6z 02 ff	// 02 = Error, Command format error
				//       01 11 | 00 04 | 00 00 00 04 | y0 6z 03 ff	// 03 = Error, Command buffer full
				//       01 11 | 00 04 | 00 00 00 05 | y0 6z 04 ff	// 04 = Error, Command cancelled
				//       01 11 | 00 04 | 00 00 00 06 | y0 6z 05 ff	// 05 = Error, No socket
				//       01 11 | 00 04 | 00 00 00 07 | y0 6z 41 ff	// 41 = Error, Command not executable
				if ((msg[8] & 0xf) == 0x0 && msg[9] >> 4 == 0x6 && msg[10] == 0x02 && msg[11] == 0xff) {
					this.log('error', 'VISCA Command ERROR: Command format error')
				} else if ((msg[8] & 0xf) == 0x0 && msg[9] >> 4 == 0x6 && msg[10] == 0x03 && msg[11] == 0xff) {
					this.log('error', 'VISCA Command ERROR: Command buffer full')
				} else if ((msg[8] & 0xf) == 0x0 && msg[9] >> 4 == 0x6 && msg[10] == 0x04 && msg[11] == 0xff) {
					this.log('error', 'VISCA Command ERROR: Command cancelled')
				} else if ((msg[8] & 0xf) == 0x0 && msg[9] >> 4 == 0x6 && msg[10] == 0x05 && msg[11] == 0xff) {
					this.log('error', 'VISCA Command ERROR: No socket')
				} else if ((msg[8] & 0xf) == 0x0 && msg[9] >> 4 == 0x6 && msg[10] == 0x41 && msg[11] == 0xff) {
					this.log('error', 'VISCA Command ERROR: Command not executable')
				} else {
					this.log('error', 'VISCA Command Reply: Unknown' + response)
				}
			}
		}
	}
	// Inquiry Packet Reply Packet
	// CAM_VersionInq 8X 09 00 02 FF Y0 50 GG GG HH HH JJ JJ KK FF
	// X = 1 to 7: Address of the unit (Locked to “X = 1” for VISCA over IP)
	// Y = 9 to F: Address of the unit +8 (Locked to “Y = 9” for VISCA over IP)
	// GGGG = Vender ID
	//   0001: Sony
	// HHHH = Model ID
	//   0519 : BRC-X1000
	//   051A : BRC-H800
	//   051B : BRC-H780
	//   051C : BRC-X400
	//   051D : BRC-X401
	//   0617 : SRG-X400
	//   061C : SRG-X402
	//   0618 : SRG-X120
	//   061A : SRG-201M2
	//   061B : SRG-HD1M2
	// JJJJ = ROM revision
	// KK = Maximum socket # (02)

	init_udp() {
		if (this.udp) {
			// close and destroy the old socket
			this.udp.removeAllListeners()
			this.udp.close()
			delete this.udp

			// this.udp.destroy()
			// delete this.udp
			this.updateStatus(InstanceStatus.Disconnected)
		}

		this.updateStatus(InstanceStatus.Connecting)

		if (this.config.host) {
			// this.udp = new UDPHelper(this.config.host, this.config.port)
			this.udp = dgram.createSocket({ type: 'udp4', reuseAddr: true })
			try {
				this.udp.bind({port:52381, exclusive: false})

				// tried also with hard coded companion ip for testing
				// this.udp.bind({address: '192.168.99.55', port:52381, exclusive: false})

				// tried also multicast addMembership
				// this.udp.bind(52381, '192.168.99.55', ()=> {
				// 	this.udp.addMembership('239.255.255.250')
				// })

				// all of the above resulted in the last instance getting all the replies
				this.duplexUDP = true
			} catch (error) {
				// if another device is listening on the port, we can still send but not receive
				// This is common with Sony VISCA over UDP
				this.log('error', 'UDP bind error: ' + error.message)
				this.duplexUDP = false
			}

			this.udp.on('error', (err) => {
				this.updateStatus(InstanceStatus.ConnectionFailure, err.message)
				this.log('error', 'Network error: ' + err.message)
			})

			this.udp.on('message', (msg, rinfo) => {
				if (rinfo.address == this.config.host) {
					this.logResponse(msg, rinfo)
				} else {
					this.log('info', 'UDP message from another address: ' + rinfo.address)
				}
			})

			this.udp.on('listening', () => {
				const address = this.udp.address()
				this.log('info', `UDP listening ${address.address}:${address.port} my camera is ${this.config.host}:${this.config.port}`)
				if (!this.duplexUDP) {
					// if connection is not duplex, assume commands are received
					this.updateStatus(InstanceStatus.Ok)
				}
			})

			this.udp.on('status_change', (status, message) => {
				this.log('info', 'UDP status_change: ' + status)
				this.updateStatus(status, message)
			})
			// Reset sequence number
			// this.VISCA.send('\x01', this.VISCA.control)
			this.send('\x01', this.VISCA.control)
			this.packet_counter = 0
		} else {
			this.log('error', 'No host configured')
			this.updateStatus(InstanceStatus.BadConfig)
		}
	}
}

runEntrypoint(SonyVISCAInstance, UpgradeScripts)
