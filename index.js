// Lazy GPIO: only load on Linux ARM devices; otherwise use a no-op mock so
// the plugin can load in Docker and on dev machines without Raspberry Pi GPIO
let Gpio = null;
let gpioAvailable = false;
if (process.platform === 'linux' && (process.arch === 'arm' || process.arch === 'arm64')) {
    try {
        Gpio = require('pigpio').Gpio;
        gpioAvailable = true;
    } catch (err) {
        // fall through to mock
    }
}

class MockGpio {
    constructor() {}
    digitalWrite() {}
}

let Service, Characteristic;

module.exports = function (homebridge) {
    Service = homebridge.hap.Service;
    Characteristic = homebridge.hap.Characteristic;
    homebridge.registerAccessory('homebridge-somfy-hotwired', 'Homebridge-somfy-hotwired', Somfy);
};

function Somfy(log, config) {
    this.service = new Service.WindowCovering(this.name);
    this.log = log;
    if (config.default_position === "up") {
        this.currentPosition = 100;
        this.targetPosition = 100;
    } else {
        this.currentPosition = 0;
        this.targetPosition = 0;
    }

    this.buttonPressDuration = 500;

    this.positionState = Characteristic.PositionState.STOPPED;

    this.pinUp = config['pin_up'];
    this.pinDown = config['pin_down'];
    this.pinMyPosition = config['pin_my_position'];
    this.movementDuration = config['movement_duration'];

    const GpioImpl = gpioAvailable ? Gpio : MockGpio;
    if (!gpioAvailable) {
        this.log('GPIO not available on this platform; running in no-op mode.');
    }
    const modeOpt = gpioAvailable ? { mode: Gpio.OUTPUT } : {};
    
    try {
        this.gpioUp = new GpioImpl(this.pinUp, modeOpt);
    } catch (err) {
        this.log('Failed to initialize gpioUp, falling back to MockGpio:', err.message);
        this.gpioUp = new MockGpio();
    }
    
    try {
        this.gpioDown = new GpioImpl(this.pinDown, modeOpt);
    } catch (err) {
        this.log('Failed to initialize gpioDown, falling back to MockGpio:', err.message);
        this.gpioDown = new MockGpio();
    }
    
    try {
        this.gpioMyPosition = new GpioImpl(this.pinMyPosition, modeOpt);
    } catch (err) {
        this.log('Failed to initialize gpioMyPosition, falling back to MockGpio:', err.message);
        this.gpioMyPosition = new MockGpio();
    }

    this.gpioUp.digitalWrite(1);
    this.gpioDown.digitalWrite(1);
    this.gpioMyPosition.digitalWrite(1);
    
    // Store pending timeouts to prevent race conditions
    this.pendingTimeouts = {
        up: null,
        down: null,
        myPosition: null
    };
}

// Helper function to press a GPIO button with race condition protection
Somfy.prototype.pressButton = function(gpio, pinName, duration) {
    // Clear any pending timeout for this pin
    if (this.pendingTimeouts[pinName]) {
        clearTimeout(this.pendingTimeouts[pinName]);
    }
    
    // Press button (LOW)
    gpio.digitalWrite(0);
    
    // Schedule release (HIGH) after duration
    this.pendingTimeouts[pinName] = setTimeout(() => {
        gpio.digitalWrite(1);
        this.pendingTimeouts[pinName] = null;
    }, duration);
};

Somfy.prototype = {
    getCurrentPosition: function (callback) {
        callback(null, this.currentPosition);
    },
    getTargetPosition: function (callback) {
        callback(null, this.targetPosition);
    },
    setTargetPosition: function (position, callback) {
        setTimeout(() => {
            clearInterval(this.interval);
            this.targetPosition = position;

            if (this.targetPosition === 100) {
                this.log('Opening shutters');

                this.pressButton(this.gpioUp, 'up', this.buttonPressDuration);

                this.intermediatePosition = false;
                this.positionState = Characteristic.PositionState.DECREASING;
            } else if (this.targetPosition === 10) {
                this.log('Going to MySomfy position');

                this.pressButton(this.gpioMyPosition, 'myPosition', this.buttonPressDuration);
                this.intermediatePosition = false;
                if (this.targetPosition > this.currentPosition) {
                    this.positionState = Characteristic.PositionState.INCREASING;
                } else {
                    this.positionState = Characteristic.PositionState.DECREASING;
                }
            } else if (this.targetPosition === 0) {
                this.log('Closing shutters');

                this.pressButton(this.gpioDown, 'down', this.buttonPressDuration);
                this.intermediatePosition = false;
                this.positionState = Characteristic.PositionState.INCREASING;
            } else {
                this.log('Opening shutters to %i percent', this.targetPosition);

                let sleepTime = this.movementDuration / 90 * this.targetPosition;
                this.log('Operation will be stopped after %i seconds', sleepTime);

                let pin = null;
                if (this.targetPosition > this.currentPosition) {
                    pin = this.pinUp;
                } else {
                    pin = this.pinDown
                }

                if (pin === this.pinUp) {
                    this.pressButton(this.gpioUp, 'up', this.buttonPressDuration);
                } else {
                    this.pressButton(this.gpioDown, 'down', this.buttonPressDuration);
                }

                this.intermediatePosition = true;
                this.positionState = Characteristic.PositionState.INCREASING;
            }

            this.interval = setInterval(() => {
                if (this.currentPosition !== this.targetPosition) {
                    if (this.targetPosition > this.currentPosition) {
                        this.currentPosition += 10;
                    } else {
                        this.currentPosition -= 10;
                    }
                    this.service.getCharacteristic(Characteristic.CurrentPosition).updateValue(this.currentPosition);
                } else {

                    if (this.intermediatePosition) {
                        this.pressButton(this.gpioMyPosition, 'myPosition', this.buttonPressDuration);
                    }

                    this.log('Operation completed!');

                    this.positionState = Characteristic.PositionState.STOPPED;
                    this.service.getCharacteristic(Characteristic.PositionState).updateValue(this.positionState);
                    clearInterval(this.interval);
                }

            }, this.movementDuration * 100);
        }, 0);

        callback(null);
    },
    getPositionState: function (callback) {
        callback(null, this.positionState);
    },

    getServices: function () {
        const informationService = new Service.AccessoryInformation();
        informationService
            .setCharacteristic(Characteristic.Manufacturer, "Somfy")
            .setCharacteristic(Characteristic.Model, "Telis 1 RTS")
            .setCharacteristic(Characteristic.SerialNumber, "1337");

        const currentPositionChar = this.service.getCharacteristic(Characteristic.CurrentPosition);
        currentPositionChar.on('get', this.getCurrentPosition.bind(this));

        const targetPositionChar = this.service.getCharacteristic(Characteristic.TargetPosition);
        targetPositionChar.setProps({
            format: Characteristic.Formats.UINT8,
            unit: Characteristic.Units.PERCENTAGE,
            maxValue: 100,
            minValue: 0,
            minStep: 10,
            perms: [Characteristic.Perms.READ, Characteristic.Perms.WRITE, Characteristic.Perms.NOTIFY]
        });
        targetPositionChar.on('get', this.getTargetPosition.bind(this));
        targetPositionChar.on('set', this.setTargetPosition.bind(this));

        this.service.getCharacteristic(Characteristic.PositionState)
            .on('get', this.getPositionState.bind(this));

        return [informationService, this.service];
    }
};
