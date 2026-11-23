/* A diskless Linux initramfs UI for the owned PVE computer-control fixture.
 * The guest has no network, disk, login, shell prompt or external credentials.
 * Real evdev input updates both the VGA console and a read-only serial receipt.
 */
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <glob.h>
#include <linux/input.h>
#include <linux/kd.h>
#include <linux/vt.h>
#include <poll.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/ioctl.h>
#include <termios.h>
#include <time.h>
#include <unistd.h>

static int tty = -1, serial = -1, shift = 0;
static long sequence, key_down, key_up, clicks, releases, wheel_y, wheel_x;
static int abs_x = -1, abs_y = -1, last_key = -1, device_count;
static char typed[1024];
static char boot_id[80];
static char last_key_device[128];

static const char plain[256] = {
  [KEY_A]='a', [KEY_B]='b', [KEY_C]='c', [KEY_D]='d', [KEY_E]='e',
  [KEY_F]='f', [KEY_G]='g', [KEY_H]='h', [KEY_I]='i', [KEY_J]='j',
  [KEY_K]='k', [KEY_L]='l', [KEY_M]='m', [KEY_N]='n', [KEY_O]='o',
  [KEY_P]='p', [KEY_Q]='q', [KEY_R]='r', [KEY_S]='s', [KEY_T]='t',
  [KEY_U]='u', [KEY_V]='v', [KEY_W]='w', [KEY_X]='x', [KEY_Y]='y', [KEY_Z]='z',
  [KEY_1]='1', [KEY_2]='2', [KEY_3]='3', [KEY_4]='4', [KEY_5]='5',
  [KEY_6]='6', [KEY_7]='7', [KEY_8]='8', [KEY_9]='9', [KEY_0]='0',
  [KEY_MINUS]='-', [KEY_EQUAL]='=', [KEY_LEFTBRACE]='[', [KEY_RIGHTBRACE]=']',
  [KEY_BACKSLASH]='\\', [KEY_SEMICOLON]=';', [KEY_APOSTROPHE]='\'',
  [KEY_GRAVE]='`', [KEY_COMMA]=',', [KEY_DOT]='.', [KEY_SLASH]='/', [KEY_SPACE]=' '
};
static const char shifted[256] = {
  [KEY_1]='!', [KEY_2]='@', [KEY_3]='#', [KEY_4]='$', [KEY_5]='%',
  [KEY_6]='^', [KEY_7]='&', [KEY_8]='*', [KEY_9]='(', [KEY_0]=')',
  [KEY_MINUS]='_', [KEY_EQUAL]='+', [KEY_LEFTBRACE]='{', [KEY_RIGHTBRACE]='}',
  [KEY_BACKSLASH]='|', [KEY_SEMICOLON]=':', [KEY_APOSTROPHE]='"',
  [KEY_GRAVE]='~', [KEY_COMMA]='<', [KEY_DOT]='>', [KEY_SLASH]='?'
};

static long long monotonic_ms(void) {
  struct timespec ts;
  clock_gettime(CLOCK_MONOTONIC, &ts);
  return (long long) ts.tv_sec * 1000 + ts.tv_nsec / 1000000;
}
static void json_text(char *out, size_t size, const char *text) {
  size_t used = 0;
  for (; *text && used + 7 < size; text++) {
    unsigned char c = (unsigned char)*text;
    if (c == '"' || c == '\\') { out[used++] = '\\'; out[used++] = (char)c; }
    else if (c < 32) { used += (size_t)snprintf(out + used, size - used, "\\u%04x", c); }
    else out[used++] = (char)c;
  }
  out[used] = 0;
}
static void render(void) {
  char escaped[sizeof(typed) * 2];
  char escaped_device[sizeof(last_key_device) * 2];
  json_text(escaped, sizeof(escaped), typed);
  json_text(escaped_device, sizeof(escaped_device), last_key_device);
  sequence++;
  dprintf(tty,
    "\033[?25l\033[H\033[2J\033[1;37;44m"
    " MCP-RELAY 0.1.9 | OWNED DISKLESS PVE FIXTURE 990190 \033[K\033[0m\r\n"
    "\r\n"
    " Real keyboard / USB tablet events drive this isolated test screen.\r\n"
    " No network, disks, login, or user data are mounted in this VM.\r\n"
    "\r\n"
    " Typed text: %-60.60s\r\n"
    "\r\n"
    " Keys down / up: %-6ld / %-6ld    Last key code: %-5d\r\n"
    " Keyboard source: %-60.60s\r\n"
    " Clicks / releases: %-6ld / %-6ld\r\n"
    " Pointer absolute X / Y: %-6d / %-6d  (0..32767)\r\n"
    " Scroll vertical / horizontal: %-6ld / %-6ld\r\n"
    "\r\n"
    " Input devices: %d       Observation sequence: %ld\r\n"
    "\r\n"
    " Mouse actions change coordinates and counters above.\r\n"
    " ASCII text appears without an implicit Enter.\r\n"
    "\r\n"
    " [ READ-ONLY RECEIPT ON SERIAL0 ]\r\n",
    typed, key_down, key_up, last_key, last_key_device, clicks, releases, abs_x, abs_y,
    wheel_y, wheel_x, device_count, sequence);
  if (abs_x >= 0 && abs_y >= 0) {
    int col = 1 + abs_x * 78 / 32767;
    int row = 20 + abs_y * 3 / 32767;
    dprintf(tty, "\033[%d;%dH\033[1;33m+\033[0m", row, col);
  }
  if (serial >= 0) dprintf(serial,
    "PVE_QA_STATE {\"fixture\":\"mcp-relay-cua-qa-019\",\"vmid\":990190,\"bootId\":\"%s\","
    "\"sequence\":%ld,\"devices\":%d,\"keyDown\":%ld,\"keyUp\":%ld,"
    "\"clicks\":%ld,\"releases\":%ld,\"x\":%d,\"y\":%d,"
    "\"wheelY\":%ld,\"wheelX\":%ld,\"lastKey\":%d,\"lastKeyDevice\":\"%s\",\"text\":\"%s\"}\n",
    boot_id, sequence, device_count, key_down, key_up, clicks, releases, abs_x, abs_y,
    wheel_y, wheel_x, last_key, escaped_device, escaped);
}
static void input_event(struct input_event *event, const char *device_name) {
  if (event->type == EV_ABS) {
    if (event->code == ABS_X) abs_x = event->value;
    if (event->code == ABS_Y) abs_y = event->value;
  } else if (event->type == EV_REL) {
    if (event->code == REL_WHEEL) wheel_y += event->value;
    if (event->code == REL_HWHEEL) wheel_x += event->value;
  } else if (event->type == EV_KEY) {
    if (event->code >= BTN_MOUSE && event->code <= BTN_TASK) {
      if (event->value == 1) clicks++;
      if (event->value == 0) releases++;
      return;
    }
    if (event->value == 1) {
      key_down++;
      snprintf(last_key_device, sizeof(last_key_device), "%s", device_name);
    }
    if (event->value == 0) key_up++;
    if (event->code == KEY_LEFTSHIFT || event->code == KEY_RIGHTSHIFT) {
      shift = event->value != 0;
      return;
    }
    if (event->value != 1) return;
    last_key = event->code;
    size_t len = strlen(typed);
    if (event->code == KEY_BACKSPACE) { if (len) typed[len - 1] = 0; return; }
    if (event->code < 256 && plain[event->code] && len + 1 < sizeof(typed)) {
      char c = plain[event->code];
      if (shift && c >= 'a' && c <= 'z') c -= 'a' - 'A';
      else if (shift && shifted[event->code]) c = shifted[event->code];
      typed[len] = c; typed[len + 1] = 0;
    }
  }
}
int main(void) {
  signal(SIGTERM, SIG_IGN);
  signal(SIGINT, SIG_IGN);
  FILE *boot = fopen("/proc/sys/kernel/random/boot_id", "r");
  if (boot) {
    if (fgets(boot_id, sizeof(boot_id), boot)) boot_id[strcspn(boot_id, "\r\n")] = 0;
    fclose(boot);
  }
  tty = open("/dev/tty1", O_RDWR | O_NOCTTY);
  if (tty < 0) tty = open("/dev/console", O_RDWR | O_NOCTTY);
  if (tty < 0) return 2;
  struct termios terminal;
  if (tcgetattr(tty, &terminal) == 0) {
    cfmakeraw(&terminal);
    tcsetattr(tty, TCSANOW, &terminal);
  }
  ioctl(tty, KDSETMODE, KD_TEXT);
  ioctl(tty, VT_ACTIVATE, 1);
  ioctl(tty, VT_WAITACTIVE, 1);
  serial = open("/dev/ttyS0", O_RDWR | O_NOCTTY | O_NONBLOCK);
  if (serial >= 0 && tcgetattr(serial, &terminal) == 0) {
    cfmakeraw(&terminal); cfsetispeed(&terminal, B115200); cfsetospeed(&terminal, B115200);
    tcsetattr(serial, TCSANOW, &terminal);
  }
  struct pollfd devices[32];
  char paths[32][128];
  char names[32][128];
  memset(devices, 0, sizeof(devices));
  memset(names, 0, sizeof(names));
  long long rescan_at = 0, draw_at = 0;
  for (;;) {
    long long now = monotonic_ms();
    if (now >= rescan_at) {
      glob_t matches;
      memset(&matches, 0, sizeof(matches));
      if (glob("/dev/input/event*", 0, NULL, &matches) == 0) {
        for (size_t n = 0; n < matches.gl_pathc && device_count < 32; n++) {
          int found = 0;
          for (int i = 0; i < device_count; i++) if (!strcmp(paths[i], matches.gl_pathv[n])) found = 1;
          if (found) continue;
          int fd = open(matches.gl_pathv[n], O_RDONLY | O_NONBLOCK);
          if (fd < 0) continue;
          snprintf(paths[device_count], sizeof(paths[device_count]), "%s", matches.gl_pathv[n]);
          if (ioctl(fd, EVIOCGNAME(sizeof(names[device_count]) - 1), names[device_count]) < 0)
            snprintf(names[device_count], sizeof(names[device_count]), "%s", matches.gl_pathv[n]);
          devices[device_count].fd = fd; devices[device_count].events = POLLIN; device_count++;
        }
      }
      globfree(&matches); rescan_at = now + 500;
    }
    int changed = 0;
    if (poll(devices, (nfds_t)device_count, 50) > 0) {
      for (int i = 0; i < device_count; i++) if (devices[i].revents & POLLIN) {
        struct input_event event;
        while (read(devices[i].fd, &event, sizeof(event)) == sizeof(event)) {
          input_event(&event, names[i]); if (event.type != EV_SYN) changed = 1;
        }
      }
    }
    if (changed || now >= draw_at) { render(); draw_at = now + 500; }
  }
}
