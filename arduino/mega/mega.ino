#include <Servo.h>
#include <string.h>
#include <stdlib.h>

// NAVONMESH '26 - Arduino Mega 2560 USB Serial Servo Controller
// Serial settings: 115200 baud, newline-terminated commands
// Commands: PING, SET,index,angle, ENABLE,index,0|1,
//           PRESET,OPEN|CLOSE, STOP, RESUME, RELEASE

const byte SERVO_COUNT = 5;
const byte servoPins[SERVO_COUNT] = {9, 10, 11, 12, 13};

Servo servos[SERVO_COUNT];
int servoAngles[SERVO_COUNT] = {90, 90, 90, 90, 90};
bool servoEnabled[SERVO_COUNT] = {true, true, true, true, true};
bool servoAttached[SERVO_COUNT] = {false, false, false, false, false};

// Standard positional servos support approximately 0–180 degrees. A 360-degree
// command range requires continuous-rotation servos and represents speed, not
// a target position. Calibrate these limits for the installed servo/mechanism.
const int MIN_ANGLE = 0;
const int MAX_ANGLE = 180;

// Example presets only; these are NOT calibrated prosthetic-hand positions.
const int openAngles[SERVO_COUNT]  = {30, 30, 30, 30, 30};
const int closeAngles[SERVO_COUNT] = {150, 150, 150, 150, 150};

bool emergencyStopped = false;

void attachServo(byte index) {
  if (index >= SERVO_COUNT || servoAttached[index]) return;

  servos[index].attach(servoPins[index]);
  servoAttached[index] = true;
  servos[index].write(servoAngles[index]);
}

void detachAllServos() {
  for (byte i = 0; i < SERVO_COUNT; i++) {
    if (servoAttached[i]) {
      servos[i].detach();
      servoAttached[i] = false;
    }
  }
}

void setServo(byte index, int angle) {
  if (index >= SERVO_COUNT) {
    Serial.println("ERROR,INVALID_SERVO");
    return;
  }

  if (emergencyStopped) {
    Serial.println("ERROR,STOPPED");
    return;
  }

  if (!servoEnabled[index]) {
    Serial.println("ERROR,SERVO_DISABLED");
    return;
  }

  angle = constrain(angle, MIN_ANGLE, MAX_ANGLE);
  servoAngles[index] = angle;
  attachServo(index);
  servos[index].write(angle);

  Serial.print("SERVO,");
  Serial.print(index);
  Serial.print(",");
  Serial.println(angle);
}

void setPreset(const int angles[]) {
  if (emergencyStopped) {
    Serial.println("ERROR,STOPPED");
    return;
  }

  for (byte i = 0; i < SERVO_COUNT; i++) {
    setServo(i, angles[i]);
  }

  Serial.println("PRESET_OK");
}

void processCommand(char *command) {
  char *type = strtok(command, ",");
  if (type == NULL) return;

  // Flask uses PING to verify that the Mega is responding.
  if (strcmp(type, "PING") == 0) {
    Serial.println("NAVONMESH_READY");
    return;
  }

  if (strcmp(type, "STOP") == 0) {
    emergencyStopped = true;
    detachAllServos();
    Serial.println("STOPPED");
    return;
  }

  if (strcmp(type, "RESUME") == 0) {
    emergencyStopped = false;
    Serial.println("RESUMED");
    return;
  }

  if (strcmp(type, "RELEASE") == 0) {
    // Releases servo holding torque by detaching signal control.
    // This does NOT disconnect the servo's electrical power.
    detachAllServos();
    Serial.println("RELEASED");
    return;
  }

  if (emergencyStopped) {
    Serial.println("ERROR,STOPPED");
    return;
  }

  if (strcmp(type, "SET") == 0) {
    char *indexText = strtok(NULL, ",");
    char *angleText = strtok(NULL, ",");

    if (indexText == NULL || angleText == NULL) {
      Serial.println("ERROR,BAD_SET_FORMAT");
      return;
    }

    int index = atoi(indexText);
    int angle = atoi(angleText);

    if (index < 0 || index >= SERVO_COUNT) {
      Serial.println("ERROR,INVALID_SERVO");
      return;
    }

    setServo((byte)index, angle);
    return;
  }

  if (strcmp(type, "ENABLE") == 0) {
    char *indexText = strtok(NULL, ",");
    char *stateText = strtok(NULL, ",");

    if (indexText == NULL || stateText == NULL) {
      Serial.println("ERROR,BAD_ENABLE_FORMAT");
      return;
    }

    int index = atoi(indexText);
    int state = atoi(stateText);

    if (index < 0 || index >= SERVO_COUNT || (state != 0 && state != 1)) {
      Serial.println("ERROR,INVALID_ENABLE_VALUE");
      return;
    }

    servoEnabled[index] = (state == 1);
    Serial.println("ENABLE_OK");
    return;
  }

  if (strcmp(type, "PRESET") == 0) {
    char *preset = strtok(NULL, ",");

    if (preset == NULL) {
      Serial.println("ERROR,MISSING_PRESET");
      return;
    }

    if (strcmp(preset, "OPEN") == 0) {
      setPreset(openAngles);
    } else if (strcmp(preset, "CLOSE") == 0) {
      setPreset(closeAngles);
    } else {
      Serial.println("ERROR,UNKNOWN_PRESET");
    }
    return;
  }

  Serial.println("ERROR,UNKNOWN_COMMAND");
}

void setup() {
  Serial.begin(115200);

  // Start each servo at the example neutral position.
  // Test with servos mechanically unloaded and safely supported.
  for (byte i = 0; i < SERVO_COUNT; i++) {
    attachServo(i);
    servos[i].write(servoAngles[i]);
  }

  Serial.println("NAVONMESH_READY");
}

void loop() {
  static char inputBuffer[64];
  static byte position = 0;

  while (Serial.available() > 0) {
    char incoming = (char)Serial.read();

    if (incoming == '\n') {
      inputBuffer[position] = '\0';
      if (position > 0) {
        processCommand(inputBuffer);
      }
      position = 0;
    } else if (incoming != '\r') {
      if (position < sizeof(inputBuffer) - 1) {
        inputBuffer[position++] = incoming;
      } else {
        // Discard an overlong command rather than processing a partial one.
        position = 0;
        Serial.println("ERROR,COMMAND_TOO_LONG");
      }
    }
  }
}
