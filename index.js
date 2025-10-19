'use strict';

const packageJSON = require('./package.json');
let Gpio = null;
let gpioAvailable = false;

// Try to load onoff
try {
  const onoff = require('onoff');
  Gpio = onoff.Gpio;
  gpioAvailable = Gpio.accessible;
  console.log('[Somfy] GPIO initialized, accessible:', gpioAvailable);
} catch (err) {
  console.warn('[Somfy] ⚠️ GPIO load failed, running in mock mode:', err.message);
}

let Service, Characteristic;

module.exports = (homebridge) => {
  Service = homebridge.hap.Service;
  Characteristic = homebridge.hap.Characteristic;
  homebridge.registerAccessory("homebridge-somfy-hotwired", "Homebridge-somfy-hotwired", Somfy);
};

class Somfy {
  constructor(log, config) {
    this.log = log;
    this.name = config.name || 'Somfy Curtain';
    
    // Read from snake_case config
    this.pinUp = config.pin_up;
    this.pinDown = config.pin_down;
    this.pinMyPosition = config.pin_my_position;
    this.movementDuration = config.movement_duration || 8; // in seconds
    this.buttonPressDuration = 500; // ms

    // Initialize position based on default_position
    if (config.default_position === "up") {
      this.currentPosition = 100;
      this.targetPosition = 100;
    } else {
      this.currentPosition = 0;
      this.targetPosition = 0;
    }

    this.positionState = 2; // stopped
    this.intermediatePosition = false;
    this.interval = null;

    // Initialize GPIO pins using onoff
    this.gpioUp = null;
    this.gpioDown = null;
    this.gpioMyPosition = null;

    if (gpioAvailable && Gpio) {
      try {
        this.gpioUp = new Gpio(this.pinUp, 'out');
        this.gpioDown = new Gpio(this.pinDown, 'out');
        this.gpioMyPosition = new Gpio(this.pinMyPosition, 'out');
        
        // Set all to HIGH (idle)
        this.gpioUp.writeSync(1);
        this.gpioDown.writeSync(1);
        this.gpioMyPosition.writeSync(1);
        
        this.log.info(`[Somfy] GPIO pins initialized - Up:${this.pinUp}, Down:${this.pinDown}, My:${this.pinMyPosition}`);
      } catch (err) {
        this.log.error(`[Somfy] Failed to initialize GPIO pins: ${err.message}`);
        gpioAvailable = false;
      }
    } else {
      this.log.warn('[Somfy] GPIO not accessible - running in mock mode');
    }

    this.service = new Service.WindowCovering(this.name);
    this.service
      .getCharacteristic(Characteristic.CurrentPosition)
      .on('get', this.getCurrentPosition.bind(this));
    this.service
      .getCharacteristic(Characteristic.PositionState)
      .on('get', this.getPositionState.bind(this));
    
    const targetPositionChar = this.service.getCharacteristic(Characteristic.TargetPosition);
    targetPositionChar.setProps({
      format: Characteristic.Formats.UINT8,
      unit: Characteristic.Units.PERCENTAGE,
      maxValue: 100,
      minValue: 0,
      minStep: 10,
      perms: [Characteristic.Perms.READ, Characteristic.Perms.WRITE, Characteristic.Perms.NOTIFY]
    });
    targetPositionChar
      .on('get', this.getTargetPosition.bind(this))
      .on('set', this.setTargetPosition.bind(this));

    // Cleanup on exit
    process.on('SIGINT', () => this.cleanup());
    process.on('SIGTERM', () => this.cleanup());

    this.log.info(`[Somfy] Initialized "${this.name}" - Current position: ${this.currentPosition}%`);
  }

  cleanup() {
    try {
      if (this.gpioUp) this.gpioUp.unexport();
      if (this.gpioDown) this.gpioDown.unexport();
      if (this.gpioMyPosition) this.gpioMyPosition.unexport();
    } catch (err) {
      // Ignore cleanup errors
    }
  }

  getCurrentPosition(callback) {
    callback(null, this.currentPosition);
  }

  getTargetPosition(callback) {
    callback(null, this.targetPosition);
  }

  getPositionState(callback) {
    callback(null, this.positionState);
  }

  setTargetPosition(value, callback) {
    this.log.info(`[Somfy] Setting target position to ${value}% (current: ${this.currentPosition}%)`);

    setTimeout(() => {
      if (this.interval) {
        clearInterval(this.interval);
      }

      this.targetPosition = value;

      if (this.targetPosition === 100) {
        this.log.info('[Somfy] Opening shutters');
        this.pressButton(this.gpioUp, this.pinUp, 'UP');
        this.intermediatePosition = false;
        this.positionState = 1; // INCREASING
        this.updatePositionState();
        this.startPositionTracking();
      } else if (this.targetPosition === 10) {
        this.log.info('[Somfy] Going to MySomfy position');
        this.pressButton(this.gpioMyPosition, this.pinMyPosition, 'MY');
        this.intermediatePosition = false;
        this.positionState = this.targetPosition > this.currentPosition ? 1 : 0;
        this.updatePositionState();
        this.startPositionTracking();
      } else if (this.targetPosition === 0) {
        this.log.info('[Somfy] Closing shutters');
        this.pressButton(this.gpioDown, this.pinDown, 'DOWN');
        this.intermediatePosition = false;
        this.positionState = 0; // DECREASING
        this.updatePositionState();
        this.startPositionTracking();
      } else {
        this.log.info(`[Somfy] Moving to intermediate position ${this.targetPosition}%`);
        
        const gpio = this.targetPosition > this.currentPosition ? this.gpioUp : this.gpioDown;
        const pin = this.targetPosition > this.currentPosition ? this.pinUp : this.pinDown;
        const pinName = this.targetPosition > this.currentPosition ? 'UP' : 'DOWN';
        
        this.pressButton(gpio, pin, pinName);
        this.intermediatePosition = true;
        this.positionState = this.targetPosition > this.currentPosition ? 1 : 0;
        this.updatePositionState();
        this.startPositionTracking();
      }
    }, 0);

    callback();
  }

  startPositionTracking() {
    this.interval = setInterval(() => {
      if (this.currentPosition !== this.targetPosition) {
        if (this.targetPosition > this.currentPosition) {
          this.currentPosition += 10;
        } else {
          this.currentPosition -= 10;
        }
        this.log.info(`[Somfy] Position update: ${this.currentPosition}%`);
        this.service.getCharacteristic(Characteristic.CurrentPosition).updateValue(this.currentPosition);
      } else {
        // Target reached
        if (this.intermediatePosition) {
          this.log.info('[Somfy] Stopping at intermediate position');
          this.pressButton(this.gpioMyPosition, this.pinMyPosition, 'MY (STOP)');
        }

        this.log.info('[Somfy] Operation completed!');
        this.positionState = 2; // STOPPED
        this.service.getCharacteristic(Characteristic.PositionState).updateValue(this.positionState);
        clearInterval(this.interval);
        this.interval = null;
      }
    }, this.movementDuration * 100); // Convert seconds to ms, then divide by 10 steps
  }

  pressButton(gpio, pin, pinName) {
    if (!gpioAvailable || !gpio) {
      this.log.warn(`[Somfy] GPIO not available, cannot press ${pinName}`);
      return;
    }

    try {
      this.log.info(`[Somfy] Pressing button ${pinName} on GPIO pin ${pin}`);
      gpio.writeSync(0); // Active LOW
      
      setTimeout(() => {
        gpio.writeSync(1); // Back to HIGH
        this.log.info(`[Somfy] Button ${pinName} released`);
      }, this.buttonPressDuration);
    } catch (err) {
      this.log.error(`[Somfy] Error pressing button ${pinName}: ${err.message}`);
    }
  }

  updatePositionState() {
    this.service.updateCharacteristic(Characteristic.PositionState, this.positionState);
    this.service.updateCharacteristic(Characteristic.CurrentPosition, this.currentPosition);
  }

  getServices() {
    const informationService = new Service.AccessoryInformation();
    informationService
      .setCharacteristic(Characteristic.Manufacturer, 'Somfy')
      .setCharacteristic(Characteristic.Model, 'Telis 1 RTS')
      .setCharacteristic(Characteristic.SerialNumber, packageJSON.version);

    return [informationService, this.service];
  }
}