#include <windows.h>
#include <shellapi.h>

#include <climits>
#include <cwchar>
#include <string>
#include <vector>

#pragma comment(lib, "shell32.lib")
#pragma comment(lib, "user32.lib")

namespace {
constexpr DWORD kRestartExitCode = 75;
constexpr wchar_t kNodeHostSwitch[] = L"--pi-node-host";
constexpr wchar_t kExecHostSwitch[] = L"--pi-silent-exec";
constexpr wchar_t kWindowTitle[] = L"Pi Portable";

std::wstring ExecutablePath() {
    DWORD capacity = 1024;
    for (;;) {
        std::vector<wchar_t> buffer(capacity);
        const DWORD length = GetModuleFileNameW(nullptr, buffer.data(), capacity);
        if (length == 0) return {};
        if (length < capacity - 1) return std::wstring(buffer.data(), length);
        if (capacity >= 32768) return {};
        capacity *= 2;
    }
}

std::wstring DirectoryName(const std::wstring& value) {
    const std::wstring::size_type slash = value.find_last_of(L"\\/");
    return slash == std::wstring::npos ? std::wstring() : value.substr(0, slash);
}

std::wstring Join(const std::wstring& left, const wchar_t* right) {
    return left + L"\\" + right;
}

bool IsFile(const std::wstring& value) {
    const DWORD attributes = GetFileAttributesW(value.c_str());
    return attributes != INVALID_FILE_ATTRIBUTES &&
           (attributes & FILE_ATTRIBUTE_DIRECTORY) == 0;
}

bool IsDirectory(const std::wstring& value) {
    const DWORD attributes = GetFileAttributesW(value.c_str());
    return attributes != INVALID_FILE_ATTRIBUTES &&
           (attributes & FILE_ATTRIBUTE_DIRECTORY) != 0;
}

std::wstring WindowsError(DWORD error) {
    wchar_t* raw = nullptr;
    const DWORD length = FormatMessageW(
        FORMAT_MESSAGE_ALLOCATE_BUFFER | FORMAT_MESSAGE_FROM_SYSTEM |
            FORMAT_MESSAGE_IGNORE_INSERTS,
        nullptr, error, 0, reinterpret_cast<wchar_t*>(&raw), 0, nullptr);
    std::wstring message = length && raw ? std::wstring(raw, length) : L"unknown error";
    if (raw) LocalFree(raw);
    while (!message.empty() && (message.back() == L'\r' || message.back() == L'\n')) {
        message.pop_back();
    }
    return message;
}

void AppendLog(const std::wstring& root, const std::wstring& message) {
    const std::wstring data = Join(root, L"data");
    if (!CreateDirectoryW(data.c_str(), nullptr) && GetLastError() != ERROR_ALREADY_EXISTS) return;
    const std::wstring log_path = Join(data, L"launcher-bootstrap.log");
    HANDLE file = CreateFileW(log_path.c_str(), FILE_APPEND_DATA,
                              FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
                              nullptr, OPEN_ALWAYS, FILE_ATTRIBUTE_NORMAL, nullptr);
    if (file == INVALID_HANDLE_VALUE) return;

    SYSTEMTIME now{};
    GetLocalTime(&now);
    wchar_t prefix[64]{};
    wsprintfW(prefix, L"[%02u:%02u:%02u.%03u] ", now.wHour, now.wMinute,
              now.wSecond, now.wMilliseconds);
    const std::wstring line = std::wstring(prefix) + message + L"\r\n";
    const int input_length = static_cast<int>(line.size());
    const int byte_count = WideCharToMultiByte(CP_UTF8, 0, line.data(), input_length,
                                                nullptr, 0, nullptr, nullptr);
    if (byte_count > 0) {
        std::vector<char> bytes(static_cast<size_t>(byte_count));
        WideCharToMultiByte(CP_UTF8, 0, line.data(), input_length, bytes.data(),
                            byte_count, nullptr, nullptr);
        DWORD written = 0;
        WriteFile(file, bytes.data(), static_cast<DWORD>(bytes.size()), &written, nullptr);
    }
    CloseHandle(file);
}

int Fail(const std::wstring& root, const std::wstring& operation, DWORD error,
         bool show_error_ui = true) {
    const std::wstring detail = operation + L" failed (" + std::to_wstring(error) +
                                L"): " + WindowsError(error);
    AppendLog(root, L"ERROR " + detail);
    if (show_error_ui) {
        MessageBoxW(nullptr, detail.c_str(), kWindowTitle,
                    MB_OK | MB_ICONERROR | MB_SETFOREGROUND);
    }
    return 1;
}

std::wstring QuoteArgument(const std::wstring& value) {
    if (!value.empty() && value.find_first_of(L" \t\n\v\"") == std::wstring::npos) {
        return value;
    }
    std::wstring result = L"\"";
    size_t backslashes = 0;
    for (const wchar_t character : value) {
        if (character == L'\\') {
            ++backslashes;
        } else if (character == L'\"') {
            result.append(backslashes * 2 + 1, L'\\');
            result.push_back(L'\"');
            backslashes = 0;
        } else {
            result.append(backslashes, L'\\');
            backslashes = 0;
            result.push_back(character);
        }
    }
    result.append(backslashes * 2, L'\\');
    result.push_back(L'\"');
    return result;
}

std::wstring BuildCommand(const std::wstring& executable,
                          const std::vector<std::wstring>& arguments) {
    std::wstring command = QuoteArgument(executable);
    for (const std::wstring& argument : arguments) {
        command += L" " + QuoteArgument(argument);
    }
    return command;
}

HANDLE CreateKillOnCloseJob(const std::wstring& root) {
    HANDLE job = CreateJobObjectW(nullptr, nullptr);
    if (!job) {
        AppendLog(root, L"WARN CreateJobObjectW failed: " +
                            std::to_wstring(GetLastError()));
        return nullptr;
    }
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits{};
    limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    if (!SetInformationJobObject(job, JobObjectExtendedLimitInformation, &limits,
                                 sizeof(limits))) {
        AppendLog(root, L"WARN SetInformationJobObject failed: " +
                            std::to_wstring(GetLastError()));
        CloseHandle(job);
        return nullptr;
    }
    return job;
}
}  // namespace

int WINAPI wWinMain(HINSTANCE, HINSTANCE, PWSTR, int) {
    const std::wstring executable = ExecutablePath();
    const std::wstring root = DirectoryName(executable);
    if (root.empty()) return Fail(L".", L"GetModuleFileNameW", GetLastError());

    int argument_count = 0;
    wchar_t** argument_values = CommandLineToArgvW(GetCommandLineW(), &argument_count);
    if (!argument_values) return Fail(root, L"CommandLineToArgvW", GetLastError());
    const bool node_host_mode = argument_count >= 2 &&
                                std::wcscmp(argument_values[1], kNodeHostSwitch) == 0;
    const bool exec_host_mode = argument_count >= 2 &&
                                std::wcscmp(argument_values[1], kExecHostSwitch) == 0;
    const bool show_error_ui = !node_host_mode && !exec_host_mode;
    if (node_host_mode && argument_count < 3) {
        LocalFree(argument_values);
        return Fail(root, L"--pi-node-host requires a target", ERROR_INVALID_PARAMETER,
                    show_error_ui);
    }
    if (exec_host_mode && argument_count < 4) {
        LocalFree(argument_values);
        return Fail(root,
                    L"--pi-silent-exec requires a working directory and executable",
                    ERROR_INVALID_PARAMETER, show_error_ui);
    }

    const std::wstring node = Join(root, L"runtime\\node.exe");
    const std::wstring script = Join(root, L"src\\launcher.mjs");
    std::wstring child_executable;
    std::wstring child_working_directory;
    std::vector<std::wstring> child_arguments;
    if (exec_host_mode) {
        child_working_directory = argument_values[2];
        child_executable = argument_values[3];
        for (int index = 4; index < argument_count; ++index) {
            child_arguments.emplace_back(argument_values[index]);
        }
        if (!IsDirectory(child_working_directory)) {
            LocalFree(argument_values);
            return Fail(root, L"working directory missing: " + child_working_directory,
                        ERROR_PATH_NOT_FOUND, show_error_ui);
        }
        if (!IsFile(child_executable)) {
            LocalFree(argument_values);
            return Fail(root, L"target executable missing: " + child_executable,
                        ERROR_FILE_NOT_FOUND, show_error_ui);
        }
    } else {
        if (!IsFile(node)) {
            LocalFree(argument_values);
            return Fail(root, L"portable node missing: " + node, ERROR_FILE_NOT_FOUND,
                        show_error_ui);
        }
        if (!node_host_mode && !IsFile(script)) {
            LocalFree(argument_values);
            return Fail(root, L"launcher missing: " + script, ERROR_FILE_NOT_FOUND,
                        show_error_ui);
        }
        child_executable = node;
        child_working_directory = root;
        if (node_host_mode) {
            for (int index = 2; index < argument_count; ++index) {
                child_arguments.emplace_back(argument_values[index]);
            }
        } else {
            child_arguments.emplace_back(script);
            for (int index = 1; index < argument_count; ++index) {
                child_arguments.emplace_back(argument_values[index]);
            }
        }
    }
    LocalFree(argument_values);

    if (!exec_host_mode) {
        bool environment_ok = SetEnvironmentVariableW(L"PI_PORTABLE_HOME", root.c_str()) &&
                              SetEnvironmentVariableW(L"PI_NODE_EXE", node.c_str()) &&
                              SetEnvironmentVariableW(L"PI_PROCESS_HOST", executable.c_str());
        if (!node_host_mode) {
            environment_ok = environment_ok &&
                             SetEnvironmentVariableW(L"PI_LAUNCH_SUPERVISOR", L"1");
        }
        if (!environment_ok) {
            return Fail(root, L"SetEnvironmentVariableW", GetLastError(), show_error_ui);
        }
    }

    SECURITY_ATTRIBUTES inherited{};
    inherited.nLength = sizeof(inherited);
    inherited.bInheritHandle = TRUE;
    HANDLE null_input = CreateFileW(L"NUL", GENERIC_READ,
                                    FILE_SHARE_READ | FILE_SHARE_WRITE, &inherited,
                                    OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr);
    if (null_input == INVALID_HANDLE_VALUE) {
        return Fail(root, L"open NUL stdin", GetLastError(), show_error_ui);
    }
    HANDLE null_output = CreateFileW(L"NUL", GENERIC_WRITE,
                                     FILE_SHARE_READ | FILE_SHARE_WRITE, &inherited,
                                     OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr);
    if (null_output == INVALID_HANDLE_VALUE) {
        const DWORD error = GetLastError();
        CloseHandle(null_input);
        return Fail(root, L"open NUL stdout", error, show_error_ui);
    }
    auto inherited_standard_handle = [](DWORD identifier, HANDLE fallback) {
        HANDLE candidate = GetStdHandle(identifier);
        if (candidate && candidate != INVALID_HANDLE_VALUE &&
            SetHandleInformation(candidate, HANDLE_FLAG_INHERIT, HANDLE_FLAG_INHERIT)) {
            return candidate;
        }
        return fallback;
    };
    const HANDLE child_input = node_host_mode
                                   ? inherited_standard_handle(STD_INPUT_HANDLE, null_input)
                                   : null_input;
    const HANDLE child_output = node_host_mode
                                    ? inherited_standard_handle(STD_OUTPUT_HANDLE, null_output)
                                    : null_output;
    const HANDLE child_error = node_host_mode
                                   ? inherited_standard_handle(STD_ERROR_HANDLE, null_output)
                                   : null_output;

    const std::wstring child_command = BuildCommand(child_executable, child_arguments);
    HANDLE job = CreateKillOnCloseJob(root);
    if (exec_host_mode && !job) {
        CloseHandle(null_input);
        CloseHandle(null_output);
        return Fail(root, L"strict task Job Object setup", ERROR_FUNCTION_FAILED,
                    show_error_ui);
    }
    const std::wstring mode_name = exec_host_mode
                                       ? L"silent-exec"
                                       : (node_host_mode ? L"node-host" : L"supervisor");
    for (;;) {
        std::vector<wchar_t> mutable_command(child_command.begin(), child_command.end());
        mutable_command.push_back(L'\0');
        STARTUPINFOW startup{};
        startup.cb = sizeof(startup);
        startup.dwFlags = STARTF_USESTDHANDLES | STARTF_USESHOWWINDOW;
        startup.wShowWindow = SW_HIDE;
        startup.hStdInput = child_input;
        startup.hStdOutput = child_output;
        startup.hStdError = child_error;
        PROCESS_INFORMATION process{};
        const DWORD flags = DETACHED_PROCESS | CREATE_UNICODE_ENVIRONMENT | CREATE_SUSPENDED;
        if (!CreateProcessW(child_executable.c_str(), mutable_command.data(), nullptr,
                            nullptr, TRUE, flags, nullptr,
                            child_working_directory.c_str(), &startup, &process)) {
            const DWORD error = GetLastError();
            if (job) CloseHandle(job);
            CloseHandle(null_input);
            CloseHandle(null_output);
            return Fail(root, L"CreateProcessW", error, show_error_ui);
        }

        if (job && !AssignProcessToJobObject(job, process.hProcess)) {
            const DWORD error = GetLastError();
            if (exec_host_mode) {
                TerminateProcess(process.hProcess, 1);
                CloseHandle(process.hThread);
                CloseHandle(process.hProcess);
                CloseHandle(job);
                CloseHandle(null_input);
                CloseHandle(null_output);
                return Fail(root, L"AssignProcessToJobObject", error, show_error_ui);
            }
            AppendLog(root, L"WARN AssignProcessToJobObject failed: " +
                                std::to_wstring(error));
        }
        if (ResumeThread(process.hThread) == static_cast<DWORD>(-1)) {
            const DWORD error = GetLastError();
            TerminateProcess(process.hProcess, 1);
            CloseHandle(process.hThread);
            CloseHandle(process.hProcess);
            if (job) CloseHandle(job);
            CloseHandle(null_input);
            CloseHandle(null_output);
            return Fail(root, L"ResumeThread", error, show_error_ui);
        }
        CloseHandle(process.hThread);
        AppendLog(root, L"START mode=" + mode_name + L" child pid=" +
                            std::to_wstring(process.dwProcessId));

        const DWORD wait = WaitForSingleObject(process.hProcess, INFINITE);
        DWORD exit_code = 1;
        if (wait != WAIT_OBJECT_0 || !GetExitCodeProcess(process.hProcess, &exit_code)) {
            const DWORD error = GetLastError();
            CloseHandle(process.hProcess);
            if (job) CloseHandle(job);
            CloseHandle(null_input);
            CloseHandle(null_output);
            return Fail(root, L"WaitForSingleObject/GetExitCodeProcess", error,
                        show_error_ui);
        }
        CloseHandle(process.hProcess);
        AppendLog(root, L"EXIT mode=" + mode_name + L" child code=" +
                            std::to_wstring(exit_code));

        if (!node_host_mode && !exec_host_mode && exit_code == kRestartExitCode) {
            AppendLog(root, L"RESTART requested by launcher");
            Sleep(200);
            continue;
        }
        if (job) CloseHandle(job);
        CloseHandle(null_input);
        CloseHandle(null_output);
        return exit_code <= static_cast<DWORD>(INT_MAX) ? static_cast<int>(exit_code) : 1;
    }
}
