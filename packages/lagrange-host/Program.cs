using System.Text.Json;
using System.Text.Json.Serialization;
using Lagrange.Core;
using Lagrange.Core.Common;
using Lagrange.Core.Common.Entity;
using Lagrange.Core.Common.Interface;
using Lagrange.Core.Events.EventArgs;

namespace SnowLuma.ProtocolHost;

internal static class Program
{
    public static async Task<int> Main(string[] args)
    {
        string? dataDir = ReadArgument(args, "--data-dir");
        if (string.IsNullOrWhiteSpace(dataDir))
        {
            Console.Error.WriteLine("missing --data-dir");
            return 2;
        }

        Directory.CreateDirectory(dataDir);
        using var runtime = new HostRuntime(dataDir);
        await runtime.Run(Console.In);
        return 0;
    }

    private static string? ReadArgument(string[] args, string name)
    {
        for (int i = 0; i + 1 < args.Length; i++)
        {
            if (args[i] == name) return args[i + 1];
        }
        return null;
    }
}

internal sealed class HostRuntime : IDisposable
{
    private const string MsgPushCommand = "trpc.msg.olpush.OlPushService.MsgPush";
    private const string KickCommand = "trpc.qq_new_tech.status_svc.StatusService.KickNT";

    private readonly object _outputLock = new();
    private readonly string _keystorePath;
    private readonly BotContext _bot;
    private CancellationTokenSource? _loginCancellation;
    private bool _disposed;

    public HostRuntime(string dataDir)
    {
        _keystorePath = Path.Combine(dataDir, "keystore.json");
        var config = new BotConfig
        {
            Protocol = Protocols.Linux,
            AutoReconnect = true,
            AutoReLogin = true,
            GetOptimumServer = true,
            LogLevel = LogLevel.Information,
        };
        BotKeystore? keystore = LoadKeystore();
        _bot = keystore is null ? BotFactory.Create(config) : BotFactory.Create(config, keystore);
        RegisterEvents();
    }

    public async Task Run(TextReader input)
    {
        while (await input.ReadLineAsync() is { } line)
        {
            HostCommand? command;
            try
            {
                command = JsonSerializer.Deserialize(line, HostJsonContext.Default.HostCommand);
            }
            catch (JsonException error)
            {
                Write(new HostFrame { Event = "error", Message = $"invalid command: {error.Message}" });
                continue;
            }
            if (command is null) continue;

            switch (command.Action)
            {
                case "start":
                    StartLogin();
                    break;
                case "send":
                    _ = SendPacket(command);
                    break;
                case "stop":
                    await Stop();
                    return;
                default:
                    Write(new HostFrame { Id = command.Id, Ok = false, Error = "unknown action" });
                    break;
            }
        }
    }

    private void StartLogin()
    {
        if (_loginCancellation is not null) return;
        _loginCancellation = new CancellationTokenSource();
        _ = Task.Run(async () =>
        {
            try
            {
                bool success = await _bot.Login(_loginCancellation.Token);
                if (!success) Write(new HostFrame { Event = "error", Message = "QQ 协议登录失败" });
            }
            catch (OperationCanceledException) { }
            catch (Exception error)
            {
                Write(new HostFrame { Event = "error", Message = error.Message });
            }
        });
    }

    private async Task SendPacket(HostCommand command)
    {
        if (command.Id is null || string.IsNullOrWhiteSpace(command.Command)) return;
        try
        {
            byte[] body = Convert.FromBase64String(command.BodyBase64 ?? "");
            BotSsoPacket reply = await _bot.SendPacket(new BotSsoPacket(command.Command, body));
            Write(new HostFrame
            {
                Id = command.Id,
                Ok = reply.RetCode == 0,
                RetCode = reply.RetCode,
                BodyBase64 = Convert.ToBase64String(reply.Data.Span),
                Error = reply.Extra,
            });
        }
        catch (Exception error)
        {
            Write(new HostFrame { Id = command.Id, Ok = false, RetCode = -1, Error = error.Message });
        }
    }

    private void RegisterEvents()
    {
        _bot.EventInvoker.RegisterEvent<BotQrCodeEvent>(OnQrCode);
        _bot.EventInvoker.RegisterEvent<BotQrCodeQueryEvent>(OnQrCodeState);
        _bot.EventInvoker.RegisterEvent<BotOnlineEvent>(OnOnline);
        _bot.EventInvoker.RegisterEvent<BotOfflineEvent>(OnOffline);
        _bot.EventInvoker.RegisterEvent<BotLoginEvent>(OnLogin);
        _bot.EventInvoker.RegisterEvent<BotRefreshKeystoreEvent>(OnRefreshKeystore);
        _bot.EventInvoker.RegisterEvent<BotRawPacketEvent>(OnRawPacket);
        _bot.EventInvoker.RegisterEvent<BotLogEvent>(OnLog);
    }

    private void OnQrCode(BotContext _, BotQrCodeEvent e) => Write(new HostFrame
    {
        Event = "qrcode",
        Url = e.Url,
        ImageBase64 = Convert.ToBase64String(e.Image),
    });

    private void OnQrCodeState(BotContext _, BotQrCodeQueryEvent e) => Write(new HostFrame
    {
        Event = "qrcode_state",
        State = e.State switch
        {
            BotQrCodeQueryEvent.TransEmpState.WaitingForScan => "waiting_scan",
            BotQrCodeQueryEvent.TransEmpState.WaitingForConfirm => "waiting_confirm",
            BotQrCodeQueryEvent.TransEmpState.Confirmed => "confirmed",
            BotQrCodeQueryEvent.TransEmpState.CodeExpired => "expired",
            BotQrCodeQueryEvent.TransEmpState.Canceled => "canceled",
            _ => "invalid",
        },
    });

    private void OnOnline(BotContext context, BotOnlineEvent _) => Write(new HostFrame
    {
        Event = "online",
        Uin = context.BotUin.ToString(),
    });

    private void OnOffline(BotContext _, BotOfflineEvent e) => Write(new HostFrame
    {
        Event = "offline",
        Reason = e.Tips?.Message ?? e.Reason.ToString(),
    });

    private void OnLogin(BotContext _, BotLoginEvent e)
    {
        if (!e.Success)
        {
            Write(new HostFrame { Event = "error", Message = e.Error?.Message ?? $"登录失败：{e.State}" });
        }
    }

    private void OnRefreshKeystore(BotContext _, BotRefreshKeystoreEvent e)
    {
        string json = JsonSerializer.Serialize(e.Keystore, HostJsonContext.Default.BotKeystore);
        string temporary = _keystorePath + ".tmp";
        File.WriteAllText(temporary, json);
        File.Move(temporary, _keystorePath, true);
    }

    private void OnRawPacket(BotContext context, BotRawPacketEvent e)
    {
        if (e.Packet.Command is not (MsgPushCommand or KickCommand)) return;
        Write(new HostFrame
        {
            Event = "packet",
            Uin = context.BotUin.ToString(),
            Command = e.Packet.Command,
            Sequence = e.Packet.Sequence,
            RetCode = e.Packet.RetCode,
            BodyBase64 = Convert.ToBase64String(e.Packet.Data.Span),
        });
    }

    private void OnLog(BotContext _, BotLogEvent e) => Write(new HostFrame
    {
        Event = "log",
        Level = e.Level.ToString().ToLowerInvariant(),
        Message = $"[{e.Tag}] {e.Message}",
    });

    private BotKeystore? LoadKeystore()
    {
        if (!File.Exists(_keystorePath)) return null;
        try
        {
            return JsonSerializer.Deserialize(File.ReadAllText(_keystorePath), HostJsonContext.Default.BotKeystore);
        }
        catch (Exception error) when (error is IOException or JsonException)
        {
            Console.Error.WriteLine($"failed to load keystore: {error.Message}");
            return null;
        }
    }

    private async Task Stop()
    {
        _loginCancellation?.Cancel();
        if (_bot.IsOnline)
        {
            try { await _bot.Logout(); } catch { }
        }
    }

    private void Write(HostFrame frame)
    {
        string line = JsonSerializer.Serialize(frame, HostJsonContext.Default.HostFrame);
        lock (_outputLock) Console.Out.WriteLine(line);
    }

    public void Dispose()
    {
        if (_disposed) return;
        _disposed = true;
        _loginCancellation?.Cancel();
        _loginCancellation?.Dispose();
        _bot.Dispose();
    }
}

internal sealed class HostCommand
{
    public int? Id { get; init; }
    public string Action { get; init; } = "";
    public string? Command { get; init; }
    public string? BodyBase64 { get; init; }
}

internal sealed class HostFrame
{
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] public int? Id { get; init; }
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] public bool? Ok { get; init; }
    [JsonPropertyName("event"), JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] public string? Event { get; init; }
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] public string? Url { get; init; }
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] public string? ImageBase64 { get; init; }
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] public string? State { get; init; }
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] public string? Uin { get; init; }
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] public string? Command { get; init; }
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingDefault)] public int Sequence { get; init; }
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingDefault)] public int RetCode { get; init; }
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] public string? BodyBase64 { get; init; }
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] public string? Error { get; init; }
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] public string? Message { get; init; }
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] public string? Reason { get; init; }
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] public string? Level { get; init; }
}

[JsonSerializable(typeof(HostCommand))]
[JsonSerializable(typeof(HostFrame))]
[JsonSerializable(typeof(BotKeystore))]
[JsonSourceGenerationOptions(PropertyNamingPolicy = JsonKnownNamingPolicy.CamelCase)]
internal partial class HostJsonContext : JsonSerializerContext;
