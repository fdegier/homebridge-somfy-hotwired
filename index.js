// Homebridge Somfy Hotwired — Node 22 & Pi 5 compatible rewrite
// F. de Gier — 2025

// Lazy-load GPIO for Linux ARM devices; fallback mock for dev / Docker
let gpiox = null;
let gpioAvailable = false;
if (process.platform === "linux" && (process.arch === "arm" || process.arch === "arm64")) {
  try {
    gpiox = require("@iiot2k/gpiox");
    gpioAvailable = true;
    console.log("[Somfy] GPIOX loaded successfully");
  } catch (err) {
    console.warn("[Somfy] ⚠️ Failed to load @iiot2k/gpiox, running in mock mode:", err.message);
  }
}

class MockGpio {
  write() {}
  close() {}
}

function makeGpio(pin, direction = "out") {
  if (!gpioAvailable) return new MockGpio();
  try {
    return gpiox.gpio(pin, direction);
  } catch (err) {
    console.warn(`[Somfy] ⚠️ Failed to initialize GPIO pin ${pin}: ${err.message}`);
    return new MockGpio();
  }
}

let Service, Characteristic;

module.exports = function (homebridge) {
  Service = homebridge.hap.Service;
  Characteristic = homebridge.hap.Characteristic;
  homebridge.registerAccessory("homebridge-somfy-hotwired", "Homebridge-somfy-hotwired", Somfy);
};

function Somfy(log, config) {
  this.log = log;
  this.name = config.name || "Somfy Hotwired";
  this.service = new Service.WindowCovering(this.name);

  // Default positions
  if (config.default_position === "up") {
    this.currentPosition = 100;
    this.targetPosition = 100;
  } else {
    this.currentPosition = 0;
    this.targetPosition = 0;
  }

  this.positionState = Characteristic.PositionState.STOPPED;
  this.buttonPressDuration = config.button_press_duration || 500;
  this.movementDuration = config.movement_duration || 20; // seconds

  // GPIO pin config
  this.pinUp = config.pin_up;
  this.pinDown = config.pin_down;
  this.pinMyPosition = config.pin_my_position;

  // Initialize GPIOs
  this.gpioUp = makeGpio(this.pinUp);
  this.gpioDown = makeGpio(this.pinDown);
  this.gpioMyPosition = makeGpio(this.pinMyPosition);

  // Set all to HIGH (inactive)
  this.gpioUp.write(1);
  this.gpioDown.write(1);
  this.gpioMyPosition.write(1);

  // Track pending timeouts to avoid race conditions
  this.pendingTimeouts = { up: null, down: null, myPosition: null };

  // Cleanup on shutdown
  process.on("SIGINT", () => {
    try {
      this.gpioUp?.close();
      this.gpioDown?.close();
      this.gpioMyPosition?.close();
    } catch (err) {
      this.log("GPIO close error:", err.message);
    }
    process.exit();
  });
}

// Helper function: press GPIO button safely
Somfy.prototype.pressButton = function (gpio, pinName, duration) {
  if (this.pendingTimeouts[pinName]) clearTimeout(this.pendingTimeouts[pinName]);
  gpio.write(0);
  this.pendingTimeouts[pinName] = setTimeout(() => {
    gpio.write(1);
    this.pendingTimeouts[pinName] = null;
  }, duration);
};

Somfy.prototype = {
  getCurrentPosition(callback) {
    callback(null, this.currentPosition);
  },

  getTargetPosition(callback) {
    callback(null, this.targetPosition);
  },

  setTargetPosition(position, callback) {
    this.targetPosition = position;
    this.log(`Target position set to ${position}%`);

    clearInterval(this.interval);

    if (this.targetPosition === 100) {
      this.log("Opening shutters");
      this.pressButton(this.gpioUp, "up", this.buttonPressDuration);
      this.positionState = Characteristic.PositionState.DECREASING;
    } else if (this.targetPosition === 10) {
      this.log("Going to MySomfy position");
      this.pressButton(this.gpioMyPosition, "myPosition", this.buttonPressDuration);
      this.positionState =
        this.targetPosition > this.currentPosition
          ? Characteristic.PositionState.INCREASING
          : Characteristic.PositionState.DECREASING;
    } else if (this.targetPosition === 0) {
      this.log("Closing shutters");
      this.pressButton(this.gpioDown, "down", this.buttonPressDuration);
      this.positionState = Characteristic.PositionState.INCREASING;
    } else {
      this.log(`Moving shutters to ${this.targetPosition}%`);
      const moveTime = (this.movementDuration / 90) * this.targetPosition;
      this.log(`Movement duration: ${moveTime}s`);
      const pin = this.targetPosition > this.currentPosition ? "up" : "down";
      const gpio = pin === "up" ? this.gpioUp : this.gpioDown;
      this.pressButton(gpio, pin, this.buttonPressDuration);
      this.positionState = Characteristic.PositionState.INCREASING;
    }

    // Update current position gradually
    this.interval = setInterval(() => {
      if (this.currentPosition !== this.targetPosition) {
        if (this.targetPosition > this.currentPosition) this.currentPosition += 10;
        else this.currentPosition -= 10;
        this.service
          .getCharacteristic(Characteristic.CurrentPosition)
          .updateValue(this.currentPosition);
      } else {
        this.log("Operation complete");
        this.positionState = Characteristic.PositionState.STOPPED;
        this.service
          .getCharacteristic(Characteristic.PositionState)
          .updateValue(this.positionState);
        clearInterval(this.interval);
      }
    }, this.movementDuration * 100);

    callback(null);
  },

  getPositionState(callback) {
    callback(null, this.positionState);
  },

  getServices() {
    const informationService = new Service.AccessoryInformation()
      .setCharacteristic(Characteristic.Manufacturer, "Somfy")
      .setCharacteristic(Characteristic.Model, "Telis 1 RTS")
      .setCharacteristic(Characteristic.SerialNumber, "1337");

    this.service
      .getCharacteristic(Characteristic.CurrentPosition)
      .on("get", this.getCurrentPosition.bind(this));

    this.service
      .getCharacteristic(Characteristic.TargetPosition)
      .setProps({
        format: Characteristic.Formats.UINT8,
        unit: Characteristic.Units.PERCENTAGE,
        maxValue: 100,
        minValue: 0,
        minStep: 10,
        perms: [
          Characteristic.Perms.READ,
          Characteristic.Perms.WRITE,
          Characteristic.Perms.NOTIFY,
        ],
      })
      .on("get", this.getTargetPosition.bind(this))
      .on("set", this.setTargetPosition.bind(this));

    this.service
      .getCharacteristic(Characteristic.PositionState)
      .on("get", this.getPositionState.bind(this));

    return [informationService, this.service];
  },
};
