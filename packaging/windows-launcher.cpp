#include <windows.h>

#include <climits>
#include <string>
#include <vector>

namespace {
constexpr DWORD kRestartExitCode = 75;
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

int Fail(const std::wstring& root, const std::wstring& operation, DWORD error) {
    const std::wstring detail = operation + L" failed (" + std::to_wstring(error) +
                                L"): " + WindowsError(error);
    AppendLog(root, L"ERROR " + detail);
    MessageBoxW(nullptr, detail.c_str(), kWindowTitle,
                MB_OK | MB_ICONERROR | MB_SETFOREGROUND);
    return 1;
}

std::wstring Quoted(const std::wstring& value) {
    return L"\"" + value + L"\"";
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

int WINAPI wWinMain(HINSTANCE, HINSTANCE, PWSTR command_line, int) {
    const std::wstring executable = ExecutablePath();
    const std::wstring root = DirectoryName(executable);
    if (root.empty()) return Fail(L".", L"GetModuleFileNameW", GetLastError());

    const std::wstring node = Join(root, L"runtime\\node.exe");
    const std::wstring script = Join(root, L"src\\launcher.mjs");
    if (!IsFile(node)) return Fail(root, L"portable node missing: " + node, ERROR_FILE_NOT_FOUND);
    if (!IsFile(script)) return Fail(root, L"launcher missing: " + script, ERROR_FILE_NOT_FOUND);

    if (!SetEnvironmentVariableW(L"PI_PORTABLE_HOME", root.c_str()) ||
        !SetEnvironmentVariableW(L"PI_NODE_EXE", node.c_str()) ||
        !SetEnvironmentVariableW(L"PI_LAUNCH_SUPERVISOR", L"1")) {
        return Fail(root, L"SetEnvironmentVariableW", GetLastError());
    }

    std::wstring child_command = Quoted(node) + L" " + Quoted(script);
    if (command_line && *command_line) child_command += L" " + std::wstring(command_line);

    HANDLE job = CreateKillOnCloseJob(root);
    for (;;) {
        std::vector<wchar_t> mutable_command(child_command.begin(), child_command.end());
        mutable_command.push_back(L'\0');
        STARTUPINFOW startup{};
        startup.cb = sizeof(startup);
        PROCESS_INFORMATION process{};
        const DWORD flags = CREATE_NO_WINDOW | CREATE_UNICODE_ENVIRONMENT | CREATE_SUSPENDED;
        if (!CreateProcessW(node.c_str(), mutable_command.data(), nullptr, nullptr, FALSE,
                            flags, nullptr, root.c_str(), &startup, &process)) {
            const DWORD error = GetLastError();
            if (job) CloseHandle(job);
            return Fail(root, L"CreateProcessW", error);
        }

        if (job && !AssignProcessToJobObject(job, process.hProcess)) {
            AppendLog(root, L"WARN AssignProcessToJobObject failed: " +
                                std::to_wstring(GetLastError()));
        }
        if (ResumeThread(process.hThread) == static_cast<DWORD>(-1)) {
            const DWORD error = GetLastError();
            TerminateProcess(process.hProcess, 1);
            CloseHandle(process.hThread);
            CloseHandle(process.hProcess);
            if (job) CloseHandle(job);
            return Fail(root, L"ResumeThread", error);
        }
        CloseHandle(process.hThread);
        AppendLog(root, L"START native supervisor child pid=" +
                            std::to_wstring(process.dwProcessId));

        const DWORD wait = WaitForSingleObject(process.hProcess, INFINITE);
        DWORD exit_code = 1;
        if (wait != WAIT_OBJECT_0 || !GetExitCodeProcess(process.hProcess, &exit_code)) {
            const DWORD error = GetLastError();
            CloseHandle(process.hProcess);
            if (job) CloseHandle(job);
            return Fail(root, L"WaitForSingleObject/GetExitCodeProcess", error);
        }
        CloseHandle(process.hProcess);
        AppendLog(root, L"EXIT child code=" + std::to_wstring(exit_code));

        if (exit_code == kRestartExitCode) {
            AppendLog(root, L"RESTART requested by launcher");
            Sleep(200);
            continue;
        }
        if (job) CloseHandle(job);
        return exit_code <= static_cast<DWORD>(INT_MAX) ? static_cast<int>(exit_code) : 1;
    }
}
