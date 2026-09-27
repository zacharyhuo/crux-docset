enum SmokeProfile: String {
    case python, go

    var bundleName: String { self == .python ? "Python" : "Go" }
    var oldLine: String { self == .python ? "3.13" : "1.26" }
    var latestLine: String { self == .python ? "3.14" : "1.27" }
    var symbols: [String] {
        self == .python ? ["list", "dict", "asyncio"] :
            ["fmt.Println", "net/http.Client", "io.Reader", "syscall.NewLazyDLL [windows/amd64]", "syscall/js.CopyBytesToGo [js/wasm]"]
    }
    // Inspected in both real indexes: present only in the newer line.
    var addedSymbol: String { self == .python ? "pathlib.Path.copy" : "bytes.CutLast" }
}

struct SmokeInvocation {
    let profile: SmokeProfile
    let oldDirectory, latestDirectory: String

    init(arguments: [String]) throws {
        if arguments.count == 2 && arguments.allSatisfy({ !$0.isEmpty && !$0.hasPrefix("--") }) {
            profile = .python
            oldDirectory = arguments[0]; latestDirectory = arguments[1]
        } else if arguments.count == 4, arguments[0] == "--profile",
                  let selected = SmokeProfile(rawValue: arguments[1]),
                  arguments.suffix(2).allSatisfy({ !$0.isEmpty && !$0.hasPrefix("--") }) {
            profile = selected
            oldDirectory = arguments[2]; latestDirectory = arguments[3]
        } else {
            throw SmokeFailure("Usage: CruxVersionSwitchSmoke [--profile python|go] OLD_RELEASE_DIR LATEST_RELEASE_DIR")
        }
    }
}
