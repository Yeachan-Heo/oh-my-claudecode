/* Node-API 8: descriptor-relative filesystem operations for the graph store. */
#define _DARWIN_C_SOURCE
#define _GNU_SOURCE
#define NAPI_VERSION 8
#include <node_api.h>
#include <sys/stat.h>
#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <math.h>
#include <stdio.h>
#include <string.h>
#include <unistd.h>

static int napi_checked(napi_env env, napi_status status) {
  if (status == napi_ok) return 1;
  bool pending = false;
  if (napi_is_exception_pending(env, &pending) == napi_ok && !pending)
    napi_throw_error(env, NULL, "Contained filesystem Node-API conversion failed");
  return 0;
}

#define CHECK(call) do { if (!napi_checked(env, (call))) return NULL; } while (0)

/* Keep the addon ABI limited to Node-API and libc (no libuv linkage). */
static const char *error_code(int error) {
  switch (error) {
#define ERROR(code) case code: return #code
    ERROR(EACCES); ERROR(EAGAIN); ERROR(EBADF); ERROR(EBUSY); ERROR(EDQUOT);
    ERROR(EEXIST); ERROR(EFAULT); ERROR(EFBIG); ERROR(EINTR); ERROR(EINVAL);
    ERROR(EIO); ERROR(EISDIR); ERROR(ELOOP); ERROR(EMFILE); ERROR(EMLINK);
    ERROR(ENAMETOOLONG); ERROR(ENFILE); ERROR(ENOENT); ERROR(ENOMEM);
    ERROR(ENOSPC); ERROR(ENOSYS); ERROR(ENOTDIR); ERROR(ENOTEMPTY);
    ERROR(ENOTSUP); ERROR(ENXIO); ERROR(EOVERFLOW); ERROR(EPERM);
    ERROR(EROFS); ERROR(ESTALE); ERROR(ETXTBSY); ERROR(EXDEV);
#undef ERROR
    default: return "UNKNOWN";
  }
}

static napi_value fail(napi_env env, const char *operation, int error) {
  napi_value message, result, code;
  char text[256];
  snprintf(text, sizeof(text), "%s: %s: %s", error_code(error), operation, strerror(error));
  CHECK(napi_create_string_utf8(env, text, NAPI_AUTO_LENGTH, &message));
  CHECK(napi_create_string_utf8(env, error_code(error), NAPI_AUTO_LENGTH, &code));
  CHECK(napi_create_error(env, code, message, &result));
  CHECK(napi_throw(env, result));
  return NULL;
}

static int arguments(napi_env env, napi_callback_info info, size_t count, napi_value *args) {
  size_t actual = count;
  if (!napi_checked(env, napi_get_cb_info(env, info, &actual, args, NULL, NULL))) return 0;
  if (actual != count) {
    napi_throw_type_error(env, NULL, "Incorrect argument count");
    return 0;
  }
  return 1;
}

static int integer(napi_env env, napi_value value, int *result) {
  double number;
  if (napi_get_value_double(env, value, &number) != napi_ok ||
      !isfinite(number) || number < 0 || number > INT_MAX || floor(number) != number) {
    napi_throw_type_error(env, NULL, "Expected a nonnegative integer fd, flags or mode");
    return 0;
  }
  *result = (int)number;
  return 1;
}

static int basename_arg(napi_env env, napi_value value, char *name) {
  size_t length, written;
  if (napi_get_value_string_utf8(env, value, NULL, 0, &length) != napi_ok ||
      length == 0 || length > NAME_MAX) {
    napi_throw_type_error(env, NULL, "Expected a nonempty basename of at most NAME_MAX bytes");
    return 0;
  }
  if (!napi_checked(env, napi_get_value_string_utf8(env, value, name, NAME_MAX + 1, &written))) return 0;
  if (written != length || strlen(name) != length || strchr(name, '/') || strchr(name, '\\') ||
      strcmp(name, ".") == 0 || strcmp(name, "..") == 0) {
    napi_throw_type_error(env, NULL, "Expected a basename without NUL, separators, dot or dot-dot");
    return 0;
  }
  return 1;
}

static napi_value undefined(napi_env env) {
  napi_value result;
  CHECK(napi_get_undefined(env, &result));
  return result;
}

static napi_value open_at(napi_env env, napi_callback_info info) {
  napi_value args[4], result;
  int directory, flags, mode;
  char name[NAME_MAX + 1];
  if (!arguments(env, info, 4, args) || !integer(env, args[0], &directory) ||
      !basename_arg(env, args[1], name) || !integer(env, args[2], &flags) ||
      !integer(env, args[3], &mode)) return NULL;
  int fd = openat(directory, name, flags | O_CLOEXEC | O_NOFOLLOW, (mode_t)mode);
  if (fd < 0) return fail(env, "openat", errno);
  if (!napi_checked(env, napi_create_int32(env, fd, &result))) { close(fd); return NULL; }
  return result;
}

static napi_value mkdir_at(napi_env env, napi_callback_info info) {
  napi_value args[3];
  int directory, mode;
  char name[NAME_MAX + 1];
  if (!arguments(env, info, 3, args) || !integer(env, args[0], &directory) ||
      !basename_arg(env, args[1], name) || !integer(env, args[2], &mode)) return NULL;
  if (mkdirat(directory, name, (mode_t)mode) < 0) return fail(env, "mkdirat", errno);
  return undefined(env);
}

static napi_value stat_at(napi_env env, napi_callback_info info) {
  napi_value args[2], result, value;
  int directory;
  char name[NAME_MAX + 1];
  struct stat status;
  if (!arguments(env, info, 2, args) || !integer(env, args[0], &directory) ||
      !basename_arg(env, args[1], name)) return NULL;
  if (fstatat(directory, name, &status, AT_SYMLINK_NOFOLLOW) < 0) return fail(env, "fstatat", errno);
  CHECK(napi_create_object(env, &result));
#define FIELD(field) do { CHECK(napi_create_double(env, (double)status.st_##field, &value)); CHECK(napi_set_named_property(env, result, #field, value)); } while (0)
  FIELD(dev); FIELD(ino); FIELD(mode); FIELD(nlink); FIELD(size);
#undef FIELD
#ifdef __APPLE__
  double mtime = (double)status.st_mtimespec.tv_sec * 1000 + (double)status.st_mtimespec.tv_nsec / 1000000;
#else
  double mtime = (double)status.st_mtim.tv_sec * 1000 + (double)status.st_mtim.tv_nsec / 1000000;
#endif
  CHECK(napi_create_double(env, mtime, &value));
  CHECK(napi_set_named_property(env, result, "mtimeMs", value));
  return result;
}

static napi_value rename_at(napi_env env, napi_callback_info info) {
  napi_value args[3];
  int directory;
  char source[NAME_MAX + 1], destination[NAME_MAX + 1];
  if (!arguments(env, info, 3, args) || !integer(env, args[0], &directory) ||
      !basename_arg(env, args[1], source) || !basename_arg(env, args[2], destination)) return NULL;
  if (renameat(directory, source, directory, destination) < 0) return fail(env, "renameat", errno);
  return undefined(env);
}

static napi_value link_at(napi_env env, napi_callback_info info) {
  napi_value args[3];
  int directory;
  char source[NAME_MAX + 1], destination[NAME_MAX + 1];
  if (!arguments(env, info, 3, args) || !integer(env, args[0], &directory) ||
      !basename_arg(env, args[1], source) || !basename_arg(env, args[2], destination)) return NULL;
  if (linkat(directory, source, directory, destination, 0) < 0) return fail(env, "linkat", errno);
  return undefined(env);
}

static napi_value unlink_at(napi_env env, napi_callback_info info) {
  napi_value args[2];
  int directory;
  char name[NAME_MAX + 1];
  if (!arguments(env, info, 2, args) || !integer(env, args[0], &directory) ||
      !basename_arg(env, args[1], name)) return NULL;
  if (unlinkat(directory, name, 0) < 0) return fail(env, "unlinkat", errno);
  return undefined(env);
}

static napi_value read_dir(napi_env env, napi_callback_info info) {
  napi_value args[1], result, value;
  int directory;
  if (!arguments(env, info, 1, args) || !integer(env, args[0], &directory)) return NULL;
  /* dup() shares directory offsets; openat(".") gives each enumeration its own. */
  int fd = openat(directory, ".", O_RDONLY | O_DIRECTORY | O_CLOEXEC);
  if (fd < 0) return fail(env, "openat directory", errno);
  DIR *stream = fdopendir(fd);
  if (!stream) { int error = errno; close(fd); return fail(env, "fdopendir", error); }
  if (!napi_checked(env, napi_create_array(env, &result))) { closedir(stream); return NULL; }
  uint32_t index = 0;
  for (;;) {
    errno = 0;
    struct dirent *entry = readdir(stream);
    if (!entry) {
      int error = errno;
      int close_result = closedir(stream);
      if (error) return fail(env, "readdir", error);
      if (close_result < 0) return fail(env, "closedir", errno);
      return result;
    }
    if (strcmp(entry->d_name, ".") == 0 || strcmp(entry->d_name, "..") == 0) continue;
    if (!napi_checked(env, napi_create_string_utf8(env, entry->d_name, NAPI_AUTO_LENGTH, &value)) ||
        !napi_checked(env, napi_set_element(env, result, index++, value))) {
      closedir(stream);
      return NULL;
    }
  }
}

static napi_value realpath_fd(napi_env env, napi_callback_info info) {
  napi_value args[1], result;
  int fd;
  char path[PATH_MAX];
  if (!arguments(env, info, 1, args) || !integer(env, args[0], &fd)) return NULL;
#ifdef __APPLE__
  if (fcntl(fd, F_GETPATH, path) < 0) return fail(env, "fcntl F_GETPATH", errno);
#else
  char descriptor[64];
  snprintf(descriptor, sizeof(descriptor), "/proc/self/fd/%d", fd);
  ssize_t length = readlink(descriptor, path, sizeof(path) - 1);
  if (length < 0) return fail(env, "readlink fd", errno);
  if ((size_t)length == sizeof(path) - 1) return fail(env, "readlink fd", ENAMETOOLONG);
  path[length] = '\0';
#endif
  CHECK(napi_create_string_utf8(env, path, NAPI_AUTO_LENGTH, &result));
  return result;
}

static napi_value initialize(napi_env env, napi_value exports) {
  napi_property_descriptor methods[] = {
    {"openAt", NULL, open_at, NULL, NULL, NULL, napi_default, NULL},
    {"mkdirAt", NULL, mkdir_at, NULL, NULL, NULL, napi_default, NULL},
    {"statAt", NULL, stat_at, NULL, NULL, NULL, napi_default, NULL},
    {"renameAt", NULL, rename_at, NULL, NULL, NULL, napi_default, NULL},
    {"unlinkAt", NULL, unlink_at, NULL, NULL, NULL, napi_default, NULL},
    {"linkAt", NULL, link_at, NULL, NULL, NULL, napi_default, NULL},
    {"readDir", NULL, read_dir, NULL, NULL, NULL, napi_default, NULL},
    {"realpathFd", NULL, realpath_fd, NULL, NULL, NULL, napi_default, NULL},
  };
  CHECK(napi_define_properties(env, exports, sizeof(methods) / sizeof(methods[0]), methods));
  return exports;
}

NAPI_MODULE(NODE_GYP_MODULE_NAME, initialize)
