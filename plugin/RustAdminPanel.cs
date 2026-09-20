using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Reflection;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;
using Oxide.Core;
using Oxide.Core.Libraries;
using Oxide.Core.Plugins;
using Oxide.Game.Rust.Cui;
using ConVar;
using Rust;
using UnityEngine;

namespace Oxide.Plugins
{
        [Info("RustAdminPanel", "RustAdminPanel", "1.3.0")]
    [Description("Free RustApp-style web admin panel: web dashboard, IP/HWID bans, VPN detection, reports, verification sessions.")]
    public class RustAdminPanel : RustPlugin
    {
        #region Configuration

        private ConfigData config;

        private class ConfigData
        {
            [JsonProperty("[Panel] Supabase project URL")]
            public string SupabaseUrl = "https://YOUR-PROJECT.supabase.co";

            [JsonProperty("[Panel] Supabase service role key (secret, plugin only)")]
            public string ServiceKey = "";

            [JsonProperty("[Panel] ProxyCheck.io API key (optional; empty = free anonymous tier)")]
            public string ProxyCheckKey = "";

            [JsonProperty("[Panel] Re-check the same IP after (hours)")]
            public float VpnRecheckHours = 12f;

            [JsonProperty("[Panel] Kick players that use a VPN/proxy")]
            public bool KickVpn = false;

            [JsonProperty("[Panel] Command poll interval (seconds)")]
            public float PollInterval = 5f;

            [JsonProperty("[UI] Chat commands")]
            public List<string> ReportCommands = new List<string> { "report", "reports" };

            [JsonProperty("[UI] Report reasons")]
            public List<string> ReportReasons = new List<string> { "Cheat", "Macros", "Abuse" };

            [JsonProperty("[UI] Cooldown between reports (seconds)")]
            public float ReportCooldown = 300f;

            [JsonProperty("[UI] Auto-parse reports from F7 (ingame reports)")]
            public bool AutoParseF7Reports = true;

            [JsonProperty("[Chat] SteamID for message avatar")]
            public string AvatarSteamId = "76561198134964268";

            [JsonProperty("[Check] Command to send contact")]
            public string ContactCommand = "contact";

            [JsonProperty("[Check] Contact message shown to players")]
            public string ContactMessage = "Our Discord: discord.gg/yourservers";

            [JsonProperty("[Components • Custom actions] Allow console command execution from panel")]
            public bool AllowConsoleCommands = true;

            [JsonProperty("[Components • Kills] Collect kills")]
            public bool CollectKills = true;

            [JsonProperty("[Components • Mutes] Support mutes system")]
            public bool SupportMutes = true;

            [JsonProperty("[Components • Chat] Collect chat messages")]
            public bool CollectChat = true;
        }

        protected override void LoadConfig()
        {
            base.LoadConfig();
            try
            {
                config = Config.ReadObject<ConfigData>();
            }
            catch
            {
                PrintWarning("Configuration file is corrupt or unreadable, generating a new default config.");
                LoadDefaultConfig();
            }
            if (config == null)
            {
                LoadDefaultConfig();
            }
            SaveConfig();
        }

        protected override void LoadDefaultConfig() => config = new ConfigData();

        #endregion

        #region Data

        private class StoredData
        {
            public long LastCommandId = 0;
        }

        private StoredData data;

        private void LoadData()
        {
            try
            {
                data = Interface.Oxide.DataFileSystem.ReadObject<StoredData>(Name);
            }
            catch
            {
                data = new StoredData();
            }
            if (data == null)
            {
                data = new StoredData();
            }
        }

        private void SaveData()
        {
            try
            {
                Interface.Oxide.DataFileSystem.WriteObject(Name, data);
            }
            catch { }
        }

        #endregion

        #region Report UI (RustApp-style in-game menu)

        private const string ReportLayer = "UI_RAP_ReportPanelUI";
        private const int ReportsPerPage = 18;
        private const int ReportGridColumns = 6;
        private const float ReportCardMargin = 8f;

        private readonly Dictionary<ulong, ReportUiState> reportUiState = new Dictionary<ulong, ReportUiState>();

        // steamid -> last report time (unix seconds). Enforces ReportCooldown.
        private readonly Dictionary<string, long> lastReportTime = new Dictionary<string, long>();

        // steamids of players that are currently muted (kept in sync with the mutes table).
        private readonly HashSet<string> mutedPlayers = new HashSet<string>();

        private class ReportUiState
        {
            public int Page;
            public string Search = string.Empty;
        }

        private ReportUiState GetReportUiState(BasePlayer player)
        {
            if (!reportUiState.TryGetValue(player.userID, out var state))
            {
                state = new ReportUiState();
                reportUiState[player.userID] = state;
            }
            return state;
        }

        private static string HexToRustFormat(string hex)
        {
            if (string.IsNullOrEmpty(hex))
            {
                hex = "#FFFFFFFF";
            }

            var str = hex.Trim('#');

            if (str.Length == 6)
            {
                str += "FF";
            }

            if (str.Length != 8)
            {
                return "1 1 1 1";
            }

            var r = byte.Parse(str.Substring(0, 2), NumberStyles.HexNumber);
            var g = byte.Parse(str.Substring(2, 2), NumberStyles.HexNumber);
            var b = byte.Parse(str.Substring(4, 2), NumberStyles.HexNumber);
            var a = byte.Parse(str.Substring(6, 2), NumberStyles.HexNumber);

            return $"{(r / 255f):F2} {(g / 255f):F2} {(b / 255f):F2} {(a / 255f):F2}";
        }

        private static string NormalizeString(string text)
        {
            var name = string.Empty;
            foreach (var c in text)
            {
                if (char.IsLetterOrDigit(c) || c == '_' || c == '-' || c == ' ' || c == '.' || c == '|' || c == '[' || c == ']' || c == '(' || c == ')')
                {
                    name += c;
                }
            }
            return name;
        }

        private void DrawReportInterface(BasePlayer player, int page = 0, string search = "", bool redraw = false)
        {
            if (player == null || !IsConfigured())
            {
                return;
            }

            var state = GetReportUiState(player);
            state.Page = page;
            state.Search = search ?? string.Empty;

            var lineAmount = ReportGridColumns;
            var lineMargin = ReportCardMargin;
            var size = (float)(700 - lineMargin * lineAmount) / lineAmount;

            var list = BasePlayer.activePlayerList.ToList();
            var finalList = list.FindAll(v => v.displayName.ToLower().Contains(state.Search.ToLower())
                                              || v.UserIDString.ToLower().Contains(state.Search.ToLower()));
            var pageList = finalList.Skip(page * ReportsPerPage).Take(ReportsPerPage).ToList();

            CuiElementContainer container = new CuiElementContainer();

            if (!redraw)
            {
                CuiHelper.DestroyUi(player, ReportLayer);

                container.Add(new CuiPanel
                {
                    CursorEnabled = true,
                    RectTransform = { AnchorMin = "0 0", AnchorMax = "1 1", OffsetMax = "0 0" },
                    Image = { Color = "0 0 0 0.8", Material = "assets/content/ui/uibackgroundblur-ingamemenu.mat" }
                }, "Overlay", ReportLayer, ReportLayer);

                container.Add(new CuiButton
                {
                    RectTransform = { AnchorMin = "0 0", AnchorMax = "1 1", OffsetMax = "0 0" },
                    Button = { Color = HexToRustFormat("#343434"), Sprite = "assets/content/ui/ui.background.transparent.radial.psd", Close = ReportLayer },
                    Text = { Text = string.Empty }
                }, ReportLayer);
            }

            container.Add(new CuiPanel
            {
                RectTransform = { AnchorMin = "0.5 0.5", AnchorMax = "0.5 0.5", OffsetMin = "-368 -200", OffsetMax = "368 142" },
                Image = { Color = "1 0 0 0" }
            }, ReportLayer, ReportLayer + ".C", ReportLayer + ".C");

            container.Add(new CuiPanel
            {
                RectTransform = { AnchorMin = "1 0", AnchorMax = "1 1", OffsetMin = "-36 0", OffsetMax = "0 0" },
                Image = { Color = "0 0 1 0" }
            }, ReportLayer + ".C", ReportLayer + ".R");

            var canGoPrev = page > 0;
            container.Add(new CuiButton
            {
                RectTransform = { AnchorMin = "0 0.5", AnchorMax = "1 1", OffsetMin = "0 4", OffsetMax = "0 0" },
                Button =
                {
                    Color = HexToRustFormat(canGoPrev ? "#D0C6BD4D" : "#D0C6BD33"),
                    Command = canGoPrev ? "rap.page " + (page - 1) : string.Empty
                },
                Text = { Text = "↑", Align = TextAnchor.MiddleCenter, Font = "robotocondensed-bold.ttf", FontSize = 24, Color = HexToRustFormat(canGoPrev ? "#D0C6BD" : "#D0C6BD4D") }
            }, ReportLayer + ".R", ReportLayer + ".RU");

            var canGoNext = list.Count > ReportsPerPage && pageList.Count == ReportsPerPage;
            container.Add(new CuiButton
            {
                RectTransform = { AnchorMin = "0 0", AnchorMax = "1 0.5", OffsetMin = "0 0", OffsetMax = "0 -4" },
                Button =
                {
                    Color = HexToRustFormat(canGoNext ? "#D0C6BD4D" : "#D0C6BD33"),
                    Command = canGoNext ? "rap.page " + (page + 1) : string.Empty
                },
                Text = { Text = "↓", Align = TextAnchor.MiddleCenter, Font = "robotocondensed-bold.ttf", FontSize = 24, Color = HexToRustFormat(canGoNext ? "#D0C6BD" : "#D0C6BD4D") }
            }, ReportLayer + ".R", ReportLayer + ".RD");

            container.Add(new CuiPanel
            {
                RectTransform = { AnchorMin = "1 1", AnchorMax = "1 1", OffsetMin = "-250 8", OffsetMax = "0 43" },
                Image = { Color = HexToRustFormat("#D0C6BD33") }
            }, ReportLayer + ".C", ReportLayer + ".S");

            container.Add(new CuiElement
            {
                Parent = ReportLayer + ".S",
                Components =
                {
                    new CuiInputFieldComponent
                    {
                        Text = lang.GetMessage("Header.Search.Placeholder", this, player.UserIDString),
                        FontSize = 14,
                        Font = "robotocondensed-regular.ttf",
                        Color = HexToRustFormat("#D0C6BD80"),
                        Align = TextAnchor.MiddleLeft,
                        Command = UiCommand("rap.search"),
                        NeedsKeyboard = true
                    },
                    new CuiRectTransformComponent { AnchorMin = "0 0", AnchorMax = "1 1", OffsetMin = "10 0", OffsetMax = "-85 0" }
                }
            });

            container.Add(new CuiButton
            {
                RectTransform = { AnchorMin = "1 0", AnchorMax = "1 1", OffsetMin = "-75 0", OffsetMax = "0 0" },
                Button = { Color = HexToRustFormat("#D0C6BD"), Material = "assets/icons/greyout.mat" },
                Text = { Text = lang.GetMessage("Header.Search", this, player.UserIDString), Font = "robotocondensed-bold.ttf", Color = HexToRustFormat("#443F3B"), FontSize = 14, Align = TextAnchor.MiddleCenter }
            }, ReportLayer + ".S", ReportLayer + ".SB");

            container.Add(new CuiPanel
            {
                RectTransform = { AnchorMin = "0 1", AnchorMax = "0.5 1", OffsetMin = "0 7", OffsetMax = "0 47" },
                Image = { Color = "0.8 0.8 0.8 0" }
            }, ReportLayer + ".C", ReportLayer + ".LT");

            var searchInfo = state.Search.Length > 0
                ? " - " + (state.Search.Length > 20 ? state.Search.Substring(0, 14).ToUpper() + "..." : state.Search.ToUpper())
                : string.Empty;

            container.Add(new CuiLabel
            {
                RectTransform = { AnchorMin = "0 0", AnchorMax = "1 1", OffsetMin = "0 0", OffsetMax = "0 0" },
                Text = { Text = lang.GetMessage("Header.Find", this, player.UserIDString) + searchInfo, Font = "robotocondensed-bold.ttf", Color = HexToRustFormat("#D0C6BD"), FontSize = 24, Align = TextAnchor.UpperLeft }
            }, ReportLayer + ".LT");

            var sub = string.IsNullOrEmpty(state.Search)
                ? lang.GetMessage("Header.SubDefault", this, player.UserIDString)
                : (pageList.Count == 0
                    ? lang.GetMessage("Header.SubFindEmpty", this, player.UserIDString)
                    : lang.GetMessage("Header.SubFindResults", this, player.UserIDString));

            container.Add(new CuiLabel
            {
                RectTransform = { AnchorMin = "0 0", AnchorMax = "1 1", OffsetMin = "0 0", OffsetMax = "0 0" },
                Text = { Text = sub, Font = "robotocondensed-regular.ttf", Color = HexToRustFormat("#D0C6BD4D"), FontSize = 14, Align = TextAnchor.LowerLeft }
            }, ReportLayer + ".LT");

            container.Add(new CuiPanel
            {
                RectTransform = { AnchorMin = "0 0", AnchorMax = "1 1", OffsetMin = "0 0", OffsetMax = "-40 0" },
                Image = { Color = "0 1 0 0" }
            }, ReportLayer + ".C", ReportLayer + ".L");

            var rows = Math.Max((int)Math.Ceiling(pageList.Count / (double)lineAmount), 3);
            for (var y = 0; y < rows; y++)
            {
                for (var x = 0; x < lineAmount; x++)
                {
                    var offsetMin = $"{x * size + lineMargin * x:F2} -{(y + 1) * size + lineMargin * y:F2}";
                    var offsetMax = $"{(x + 1) * size + lineMargin * x:F2} -{y * size + lineMargin * y:F2}";

                    var target = pageList.ElementAtOrDefault(y * lineAmount + x);
                    if (target == null)
                    {
                        container.Add(new CuiPanel
                        {
                            RectTransform = { AnchorMin = "0 1", AnchorMax = "0 1", OffsetMin = offsetMin, OffsetMax = offsetMax },
                            Image = { Color = HexToRustFormat("#D0C6BD33") }
                        }, ReportLayer + ".L");
                        continue;
                    }

                    var cardName = ReportLayer + $".P{target.userID}";
                    container.Add(new CuiPanel
                    {
                        RectTransform = { AnchorMin = "0 1", AnchorMax = "0 1", OffsetMin = offsetMin, OffsetMax = offsetMax },
                        Image = { Color = HexToRustFormat("#D0C6BD33") }
                    }, ReportLayer + ".L", cardName);

                    container.Add(new CuiElement
                    {
                        Parent = cardName,
                        Components =
                        {
                            new CuiRawImageComponent { SteamId = target.UserIDString, Sprite = "assets/icons/loading.png" },
                            new CuiRectTransformComponent { AnchorMin = "0 0", AnchorMax = "1 1", OffsetMax = "0 0" }
                        }
                    });

                    container.Add(new CuiPanel
                    {
                        RectTransform = { AnchorMin = "0 0", AnchorMax = "1 1" },
                        Image = { Sprite = "assets/content/ui/ui.background.transparent.linear.psd", Color = HexToRustFormat("#282828F2") }
                    }, cardName);

                    var normaliseName = NormalizeString(target.displayName);
                    var name = normaliseName.Length > 14 ? normaliseName.Substring(0, 15) + ".." : normaliseName;

                    container.Add(new CuiLabel
                    {
                        RectTransform = { AnchorMin = "0 0", AnchorMax = "1 1", OffsetMin = "6 16" },
                        Text = { Text = name, Align = TextAnchor.LowerLeft, Font = "robotocondensed-bold.ttf", FontSize = 13, Color = HexToRustFormat("#D0C6BD") }
                    }, cardName);

                    container.Add(new CuiLabel
                    {
                        RectTransform = { AnchorMin = "0 0", AnchorMax = "1 1", OffsetMin = "6 5" },
                        Text = { Text = target.UserIDString, Align = TextAnchor.LowerLeft, Font = "robotocondensed-regular.ttf", FontSize = 10, Color = HexToRustFormat("#D0C6BD80") }
                    }, cardName);

                    container.Add(new CuiButton
                    {
                        RectTransform = { AnchorMin = "0 0", AnchorMax = "1 1" },
                        Button = { Color = "0 0 0 0", Command = "rap.select " + target.UserIDString },
                        Text = { Text = string.Empty }
                    }, cardName);
                }
            }

            CuiHelper.AddUi(player, container);
        }

        private void DrawPlayerReportReasons(BasePlayer player, string targetId)
        {
            if (player == null || !IsConfigured())
            {
                return;
            }

            var target = BasePlayer.Find(targetId) ?? BasePlayer.FindSleeping(targetId);
            if (target == null)
            {
                return;
            }

            PlayClickEffect(player);

            var state = GetReportUiState(player);

            var list = BasePlayer.activePlayerList.ToList();
            var finalList = list.FindAll(v => v.displayName.ToLower().Contains(state.Search.ToLower())
                                              || v.UserIDString.ToLower().Contains(state.Search.ToLower()));
            var pageIndex = finalList.IndexOf(target);
            if (pageIndex < 0 || pageIndex < state.Page * ReportsPerPage || pageIndex >= (state.Page + 1) * ReportsPerPage)
            {
                return;
            }

            var indexOnPage = pageIndex - state.Page * ReportsPerPage;
            var lineMargin = ReportCardMargin;
            var size = (float)(700 - lineMargin * ReportGridColumns) / ReportGridColumns;
            var x = indexOnPage % ReportGridColumns;
            var y = indexOnPage / ReportGridColumns;
            var offsetMin = $"{x * size + lineMargin * x:F2} -{(y + 1) * size + lineMargin * y:F2}";
            var offsetMax = $"{(x + 1) * size + lineMargin * x:F2} -{y * size + lineMargin * y:F2}";
            var leftAlign = x >= 3;

            CuiElementContainer container = new CuiElementContainer();
            CuiHelper.DestroyUi(player, ReportLayer + ".T");

            container.Add(new CuiPanel
            {
                RectTransform = { AnchorMin = "0 1", AnchorMax = "0 1", OffsetMin = offsetMin, OffsetMax = offsetMax },
                Image = { Color = "0 0 0 1" }
            }, ReportLayer + ".L", ReportLayer + ".T");

            container.Add(new CuiButton
            {
                RectTransform = { AnchorMin = "0 0", AnchorMax = "1 1", OffsetMin = "-500 -500", OffsetMax = "500 500" },
                Button = { Close = ReportLayer + ".T", Color = "0 0 0 1", Sprite = "assets/content/ui/gameui/attackheli/compass/ui.soft.radial.png" },
                Text = { Text = string.Empty }
            }, ReportLayer + ".T");

            container.Add(new CuiButton
            {
                RectTransform = { AnchorMin = leftAlign ? "-1 0" : "2 0", AnchorMax = leftAlign ? "-2 1" : "3 1", OffsetMin = "-500 -500", OffsetMax = "500 500" },
                Button = { Close = ReportLayer + ".T", Color = HexToRustFormat("#343434"), Sprite = "assets/content/ui/gameui/attackheli/compass/ui.soft.radial.png" },
                Text = { Text = string.Empty }
            }, ReportLayer + ".T");

            container.Add(new CuiButton
            {
                RectTransform = { AnchorMin = "0 0", AnchorMax = "1 1", OffsetMin = "-1111111 -1111111", OffsetMax = "1111111 1111111" },
                Button = { Close = ReportLayer + ".T", Color = "0 0 0 0.5", Material = "assets/content/ui/uibackgroundblur-ingamemenu.mat" },
                Text = { Text = string.Empty }
            }, ReportLayer + ".T");

            container.Add(new CuiLabel
            {
                RectTransform = { AnchorMin = leftAlign ? "0 0" : "1 0", AnchorMax = leftAlign ? "0 1" : "1 1", OffsetMin = leftAlign ? "-350 0" : "20 0", OffsetMax = leftAlign ? "-20 -5" : "350 -5" },
                Text = { FadeIn = 0.4f, Text = lang.GetMessage("Subject.Head", this, player.UserIDString), Font = "robotocondensed-bold.ttf", Color = HexToRustFormat("#D0C6BD"), FontSize = 24, Align = leftAlign ? TextAnchor.UpperRight : TextAnchor.UpperLeft }
            }, ReportLayer + ".T");

            container.Add(new CuiLabel
            {
                RectTransform = { AnchorMin = leftAlign ? "0 0" : "1 0", AnchorMax = leftAlign ? "0 1" : "1 1", OffsetMin = leftAlign ? "-250 0" : "20 0", OffsetMax = leftAlign ? "-20 -35" : "250 -35" },
                Text = { FadeIn = 0.4f, Text = lang.GetMessage("Subject.SubHead", this, player.UserIDString).Replace("%PLAYER%", $"<b>{NormalizeString(target.displayName)}</b>"), Font = "robotocondensed-regular.ttf", Color = HexToRustFormat("#D0C6BD80"), FontSize = 14, Align = leftAlign ? TextAnchor.UpperRight : TextAnchor.UpperLeft }
            }, ReportLayer + ".T");

            container.Add(new CuiElement
            {
                Parent = ReportLayer + ".T",
                Components =
                {
                    new CuiRawImageComponent { SteamId = target.UserIDString, Sprite = "assets/icons/loading.png" },
                    new CuiRectTransformComponent { AnchorMin = "0 0", AnchorMax = "1 1", OffsetMax = "0 0" }
                }
            });

            for (var i = 0; i < config.ReportReasons.Count; i++)
            {
                var reason = config.ReportReasons[i];

                var offXMin = (20 + (i * 5)) + i * 80;
                var offXMax = 20 + (i * 5) + (i + 1) * 80;

                container.Add(new CuiButton
                {
                    RectTransform = { AnchorMin = leftAlign ? "0 0" : "1 0", AnchorMax = leftAlign ? "0 0" : "1 0", OffsetMin = leftAlign ? $"-{offXMax} 15" : $"{offXMin} 15", OffsetMax = leftAlign ? $"-{offXMin} 45" : $"{offXMax} 45" },
                    Button = { FadeIn = 0.4f + i * 0.2f, Color = HexToRustFormat("#D0C6BD4D"), Command = $"rap.reason {target.UserIDString} {i}" },
                    Text = { FadeIn = 0.4f + i * 0.2f, Text = reason, Align = TextAnchor.MiddleCenter, Font = "robotocondensed-bold.ttf", FontSize = 16, Color = HexToRustFormat("#D0C6BD") }
                }, ReportLayer + ".T");
            }

            CuiHelper.AddUi(player, container);
        }

        private void PlayClickEffect(BasePlayer player)
        {
            try
            {
                var effect = new Effect("assets/prefabs/tools/detonator/effects/unpress.prefab", player, 0, new Vector3(), new Vector3());
                EffectNetwork.Send(effect, player.Connection);
            }
            catch
            {
            }
        }

        private void SoundToast(BasePlayer player, string text, int type = 2)
        {
            try
            {
                var effect = new Effect("assets/bundled/prefabs/fx/notice/item.select.fx.prefab", player, 0, new Vector3(), new Vector3());
                EffectNetwork.Send(effect, player.Connection);
                player.Command("gametip.showtoast", type, text, 1);
            }
            catch
            {
                SendMessage(player, text);
            }
        }

        private void DestroyReportUi(BasePlayer player)
        {
            if (player == null)
            {
                return;
            }
            CuiHelper.DestroyUi(player, ReportLayer);
            reportUiState.Remove(player.userID);
        }

        private void DestroyAllReportUi()
        {
            foreach (var player in BasePlayer.activePlayerList)
            {
                CuiHelper.DestroyUi(player, ReportLayer);
            }
            reportUiState.Clear();
        }

        #endregion

        #region UI commands

        private string UiCommand<T>(string commandName, T arg)
        {
            return $"{commandName} {JsonConvert.SerializeObject(arg)}";
        }

        private string UiCommand(string commandName)
        {
            return commandName;
        }

        [ConsoleCommand("rap.page")]
        private void CmdReportPage(ConsoleSystem.Arg args)
        {
            var player = args.Player();
            if (player == null || !IsConfigured())
            {
                return;
            }

            var state = GetReportUiState(player);
            var page = state.Page;

            try
            {
                var raw = args.GetString(0);
                if (!string.IsNullOrEmpty(raw) && int.TryParse(raw, out var p))
                {
                    page = p;
                }
            }
            catch
            {
            }

            DrawReportInterface(player, Math.Max(0, page), state.Search, true);
        }

        [ConsoleCommand("rap.search")]
        private void CmdReportSearch(ConsoleSystem.Arg args)
        {
            var player = args.Player();
            if (player == null || !IsConfigured())
            {
                return;
            }

            var search = string.Empty;
            try
            {
                search = args.GetString(0) ?? string.Empty;
            }
            catch
            {
            }

            DrawReportInterface(player, 0, search, true);
        }

        [ConsoleCommand("rap.select")]
        private void CmdReportSelect(ConsoleSystem.Arg args)
        {
            var player = args.Player();
            if (player == null || !IsConfigured())
            {
                return;
            }

            var targetId = args.GetString(0);
            if (string.IsNullOrEmpty(targetId))
            {
                return;
            }

            DrawPlayerReportReasons(player, targetId);
        }

        [ConsoleCommand("rap.reason")]
        private void CmdReportReason(ConsoleSystem.Arg args)
        {
            var player = args.Player();
            if (player == null || !IsConfigured())
            {
                return;
            }

            var targetId = args.GetString(0);
            if (string.IsNullOrEmpty(targetId))
            {
                return;
            }

            int index = -1;
            try
            {
                index = args.GetInt(1);
            }
            catch
            {
            }

            if (index < 0 || index >= config.ReportReasons.Count)
            {
                return;
            }

            SendReportFromUi(player, targetId, config.ReportReasons[index]);
        }

        #endregion

        #region Init (original)

        private void Init()
        {
            LoadConfig();
            LoadData();

            lang.RegisterMessages(new Dictionary<string, string>
            {
                ["ReportSent"] = "Your report has been sent to the server admins.",
                ["ReportCooldown"] = "You must wait {0}s before sending another report.",
                ["ReportUsage"] = "Usage: /{0} <player name or steamid> <reason>",
                ["MutedMessage"] = "You are muted. Reason: {0}",
                ["BannedMessage"] = "You are banned on this server. Reason: {0}",
                ["Header.Find"] = "FIND PLAYER",
                ["Header.SubDefault"] = "Who do you want to report?",
                ["Header.SubFindResults"] = "Here are players, which we found",
                ["Header.SubFindEmpty"] = "No players was found",
                ["Header.Search"] = "Search",
                ["Header.Search.Placeholder"] = "Enter nickname/steamid",
                ["Subject.Head"] = "Select the reason for the report",
                ["Subject.SubHead"] = "For player %PLAYER%",
                ["UI.Close"] = "Close",
                ["Check.NoticeTitle"] = "VERIFICATION",
                ["Check.NoticeText"] = "<color=#c6bdb4><size=32><b>YOU ARE SUMMONED FOR A CHECK-UP</b></size></color>\n<color=#958D85>You have <color=#c6bdb4><b>3 minutes</b></color> to join our Discord and send your contact.\nDiscord: <color=#c6bdb4>{0}</color>\nUse the <b><color=#c6bdb4>/{1}</color></b> command to send your Discord.\n\nTo contact a moderator - use chat, not a command.</color>",
                ["Check.NoticeButton"] = "I understand",
                ["Contact.Error"] = "You did not send your Discord",
                ["Contact.Sent"] = "You sent:",
                ["Contact.SentWait"] = "If you sent the correct discord - wait for a friend request.",
                ["Check.TargetNotFound"] = "Player not found. He may have left the server."
            }, this);

            lang.RegisterMessages(new Dictionary<string, string>
            {
                ["ReportSent"] = "Жалоба отправлена администрации сервера.",
                ["ReportCooldown"] = "Подожди {0} сек. перед следующей жалобой.",
                ["ReportUsage"] = "Использование: /{0} <ник или steamid> <причина>",
                ["MutedMessage"] = "Ты в муте. Причина: {0}",
                ["BannedMessage"] = "Ты забанен на этом сервере. Причина: {0}",
                ["Header.Find"] = "НАЙТИ ИГРОКА",
                ["Header.SubDefault"] = "На кого вы хотите пожаловаться?",
                ["Header.SubFindResults"] = "Вот игроки, которых мы нашли",
                ["Header.SubFindEmpty"] = "Игроки не найдены",
                ["Header.Search"] = "Поиск",
                ["Header.Search.Placeholder"] = "Введите ник/steamid",
                ["Subject.Head"] = "Выберите причину репорта",
                ["Subject.SubHead"] = "На игрока %PLAYER%",
                ["UI.Close"] = "Закрыть",
                ["Check.NoticeTitle"] = "ПРОВЕРКА",
                ["Check.NoticeText"] = "<color=#c6bdb4><size=32><b>ВАС ВЫЗВАЛИ НА ПРОВЕРКУ</b></size></color>\n<color=#958D85>У вас есть <color=#c6bdb4><b>3 минуты</b></color>, чтобы зайти в наш Discord и отправить свои контакты.\nDiscord: <color=#c6bdb4>{0}</color>\nИспользуйте команду <b><color=#c6bdb4>/{1}</color></b>, чтобы отправить свой Discord.\n\nЧтобы связаться с модератором — используйте чат, а не команду.</color>",
                ["Check.NoticeButton"] = "Понятно",
                ["Contact.Error"] = "Вы не отправили свой Discord",
                ["Contact.Sent"] = "Вы отправили:",
                ["Contact.SentWait"] = "Если вы отправили правильный дискорд — ждите заявку в друзья.",
                ["Check.TargetNotFound"] = "Игрок не найден — возможно, он покинул сервер."
            }, this, "ru");
        }

        private void OnServerInitialized(bool initial)
        {
            if (!IsConfigured())
            {
                PrintError("RustAdminPanel is NOT configured. Open oxide/config/RustAdminPanel.json, fill in the Supabase URL and service role key, then run: o.reload RustAdminPanel");
                return;
            }

            Heartbeat();
            FpsLoop();
            LoadActiveChecks();
            RefreshAllMutes();
            timer.Repeat(Math.Max(2f, config.PollInterval), 0, PollCommands);
            timer.Repeat(30f, 0, Heartbeat);
            timer.Repeat(300f, 0, LogOnlineHistory);
            timer.Repeat(60f, 0, RefreshAllMutes);
            timer.Repeat(15f, 0, RefreshPings);
        }

        private void Unload()
        {
            DestroyAllReportUi();
            DestroyAllCheckNotices();
            MarkAllOffline();
        }

        private void OnServerShutdown() => MarkAllOffline();

        private bool IsConfigured()
        {
            return config != null
                   && !string.IsNullOrEmpty(config.SupabaseUrl)
                   && config.SupabaseUrl.StartsWith("http", StringComparison.OrdinalIgnoreCase)
                   && !config.SupabaseUrl.Contains("YOUR-PROJECT")
                   && !string.IsNullOrEmpty(config.ServiceKey)
                   && config.ServiceKey.Length > 20;
        }

        #endregion

        #region HTTP helpers

        private const string RestBase = "/rest/v1/";

        private string Url(string path)
        {
            return config.SupabaseUrl.TrimEnd('/') + (path.StartsWith("/") ? path : RestBase + path);
        }

        private Dictionary<string, string> AuthHeaders()
        {
            return new Dictionary<string, string>
            {
                { "apikey", config.ServiceKey },
                { "Authorization", "Bearer " + config.ServiceKey },
                { "Content-Type", "application/json" }
            };
        }

        private static bool Ok(int code)
        {
            return code >= 200 && code < 300;
        }

        private void Get(string path, Action<int, string> callback, float timeout = 10f)
        {
            try
            {
                webrequest.Enqueue(Url(path), null, (code, response) =>
                {
                    try
                    {
                        if (!Ok(code) || string.IsNullOrEmpty(response))
                        {
                            callback?.Invoke(code, null);
                            return;
                        }
                        callback?.Invoke(code, response);
                    }
                    catch (Exception ex) { PrintError($"Get callback failed ({path}): {ex.Message}"); }
                }, this, RequestMethod.GET, AuthHeaders(), timeout);
            }
            catch (Exception ex) { PrintError($"Get failed ({path}): {ex.Message}"); }
        }

        private void Post(string path, string body, Action<int, string> callback = null, bool upsert = false)
        {
            try
            {
                var headers = AuthHeaders();
                headers["Prefer"] = upsert ? "return=minimal, resolution=merge-duplicates" : "return=minimal";
                webrequest.Enqueue(Url(path), body, (code, response) =>
                {
                    try { callback?.Invoke(code, response); }
                    catch (Exception ex) { PrintError($"Post callback failed ({path}): {ex.Message}"); }
                }, this, RequestMethod.POST, headers, 10f);
            }
            catch (Exception ex) { PrintError($"Post failed ({path}): {ex.Message}"); }
        }

        private void Patch(string path, string body, Action<int, string> callback = null)
        {
            try
            {
                var headers = AuthHeaders();
                headers["Prefer"] = "return=minimal";
                webrequest.Enqueue(Url(path), body, (code, response) =>
                {
                    try { callback?.Invoke(code, response); }
                    catch (Exception ex) { PrintError($"Patch callback failed ({path}): {ex.Message}"); }
                }, this, RequestMethod.PATCH, headers, 10f);
            }
            catch (Exception ex) { PrintError($"Patch failed ({path}): {ex.Message}"); }
        }

        private static string GetStr(JObject o, string key)
        {
            var t = o[key];
            if (t == null || t.Type == JTokenType.Null)
            {
                return null;
            }
            return t.ToString();
        }

        private static long? GetLong(JObject o, string key)
        {
            var t = o[key];
            if (t == null || t.Type == JTokenType.Null)
            {
                return null;
            }
            try
            {
                return (long)t;
            }
            catch { return null; }
        }

        #endregion

        #region Player connection

        private void OnPlayerConnected(BasePlayer player)
        {
            if (player == null || !IsConfigured())
            {
                return;
            }
            PInfo iPlayer = GetInfo(player);
            if (iPlayer == null || string.IsNullOrEmpty(iPlayer.Id))
            {
                return;
            }

            string steamid = iPlayer.Id;
            string ip = CleanIp(iPlayer.Address);
            string hwid = GetHwid(iPlayer);
            string name = iPlayer.Name;

            InsertConnectionLog(steamid, name, ip, "join");

            long? rejoinedCheck = GetActiveCheckId(steamid);
            if (rejoinedCheck.HasValue)
            {
                AddCheckEvent(rejoinedCheck.Value, "event", "player reconnected");
            }

            string filter = "active=eq.true&order=id.desc&limit=1&or=(" +
                            $"steamid.eq.{steamid},ip.eq.{ip}" + (string.IsNullOrEmpty(hwid) ? "" : $",hwid.eq.{hwid}") + ")";

            Get("/rest/v1/bans?select=id,reason,expires_at&" + filter, (code, response) =>
            {
                if (code == 200 && !string.IsNullOrEmpty(response))
                {
                    try
                    {
                        var arr = JArray.Parse(response);
                        if (arr.Count > 0)
                        {
                            var ban = arr[0];
                            var exp = ban["expires_at"];
                            DateTime? expires = ParseUtcDate(exp);
                            bool permanent = !expires.HasValue;

                            if (permanent || expires.Value > DateTime.UtcNow)
                            {
                                string reason = GetStr((JObject)ban, "reason") ?? "Banned";
                                iPlayer.Kick(string.Format(lang.GetMessage("BannedMessage", this, iPlayer.Id), reason));
                                LogCommand($"Kicked banned player {name} ({steamid} / {ip}): {reason}");
                                return;
                            }

                            Patch("/rest/v1/bans?id=eq." + ban["id"], new JObject { ["active"] = false }.ToString());
                        }
                    }
                    catch (Exception ex)
                    {
                        PrintError($"Ban check parse error for {steamid}: {ex.Message}");
                    }
                }

                UpsertPlayer(player, iPlayer);
            });
        }

        private void OnPlayerDisconnected(BasePlayer player)
        {
            if (player == null)
            {
                return;
            }
            DestroyReportUi(player);
            DestroyCheckNotice(player);

            if (!IsConfigured())
            {
                return;
            }
            PInfo iPlayer = GetInfo(player);
            if (iPlayer == null)
            {
                return;
            }
            InsertConnectionLog(iPlayer.Id, iPlayer.Name, CleanIp(iPlayer.Address), "quit");

            long? leftCheck = GetActiveCheckId(iPlayer.Id);
            if (leftCheck.HasValue)
            {
                AddCheckEvent(leftCheck.Value, "event", "player disconnected");
            }

            var body = new JObject
            {
                ["online"] = false,
                ["last_seen"] = DateTime.UtcNow.ToString("o", CultureInfo.InvariantCulture),
                ["ping"] = GetInfo(player)?.Ping ?? 0
            };
            Patch($"/rest/v1/players?steamid=eq.{iPlayer.Id}", body.ToString());
        }

        private void UpsertPlayer(BasePlayer player, PInfo iPlayer)
        {
            // NOTE: is_vpn / vpn_checked are intentionally NOT reset here. CheckVpn()
            // sets them from proxycheck.io on first sight and restores the cached
            // result on later connects, so the panel never loses the VPN flag.
            var body = new JObject
            {
                ["steamid"] = iPlayer.Id,
                ["name"] = iPlayer.Name,
                ["ip"] = CleanIp(iPlayer.Address),
                ["hwid"] = GetHwid(iPlayer),
                ["online"] = true,
                ["ping"] = GetInfo(player)?.Ping ?? 0,
                ["last_seen"] = DateTime.UtcNow.ToString("o", CultureInfo.InvariantCulture)
            };
            Post("/rest/v1/players?on_conflict=steamid", body.ToString(), (code, response) =>
            {
                if (Ok(code))
                {
                    Post("/rest/v1/rpc/increment_connections", new JObject { ["p_steamid"] = iPlayer.Id }.ToString());
                    CheckVpn(player, iPlayer);
                    if (config.SupportMutes)
                    {
                        RefreshMuteCache(iPlayer.Id);
                    }
                }
                else
                {
                    PrintWarning($"Player upsert failed ({code}): {response}");
                }
            }, upsert: true);
        }

        private void MarkAllOffline()
        {
            if (!IsConfigured())
            {
                return;
            }
            try
            {
                var body = new JObject
                {
                    ["online"] = false,
                    ["last_seen"] = DateTime.UtcNow.ToString("o", CultureInfo.InvariantCulture)
                };
                Patch("/rest/v1/players?online=eq.true", body.ToString());
            }
            catch (Exception ex)
            {
                PrintError($"MarkAllOffline failed: {ex.Message}");
            }
        }

        private static string CleanIp(string address)
        {
            if (string.IsNullOrEmpty(address))
            {
                return string.Empty;
            }
            string ip = address.Trim();
            if (ip.StartsWith("["))
            {
                int end = ip.IndexOf(']');
                if (end > 0)
                {
                    return ip.Substring(1, end - 1);
                }
            }
            int cut = ip.LastIndexOf(':');
            if (cut > 0)
            {
                return ip.Substring(0, cut);
            }
            return ip;
        }

        #endregion

        #region VPN / IP detection (proxycheck.io)

        // ip -> last lookup time (unix seconds). proxycheck.io has a free daily quota,
        // so the same IP is only re-checked after VpnRecheckHours.
        private readonly Dictionary<string, long> ipCheckedAt = new Dictionary<string, long>();

        private void CheckVpn(BasePlayer player, PInfo iPlayer)
        {
            string ip = CleanIp(iPlayer.Address);
            if (string.IsNullOrEmpty(ip))
            {
                return;
            }

            long now = ToUnixTime(DateTime.UtcNow);
            if (ipCheckedAt.TryGetValue(ip, out long at) && now - at < (long)(Math.Max(1f, config.VpnRecheckHours) * 3600f))
            {
                // The IP was checked recently. Restore the last known result from ip_checks
                // so the player row does not lose its VPN flag after a reconnect.
                RestoreCachedIpCheck(ip, iPlayer.Id);
                return;
            }
            ipCheckedAt[ip] = now;

            LookupIp(ip, iPlayer.Id, iPlayer.Name, "auto", (isVpn, check) =>
            {
                if (isVpn)
                {
                    LogCommand($"VPN/proxy detected: {iPlayer.Name} ({iPlayer.Id} / {ip}) {FormatIpResult(check)}");
                    InsertAlert("vpn", $"VPN/proxy: {iPlayer.Name} ({ip})");
                    if (config.KickVpn)
                    {
                        iPlayer.Kick("VPN / proxy connections are not allowed on this server");
                    }
                }
            });
        }

        // Applies the most recent ip_checks row for the given IP onto the player row,
        // without making a new proxycheck.io request (free quota protection).
        private void RestoreCachedIpCheck(string ip, string steamid)
        {
            if (string.IsNullOrEmpty(steamid))
            {
                return;
            }

            Get($"/rest/v1/ip_checks?ip=eq.{ip}&order=created_at.desc&limit=1&select=is_vpn,country,country_code,isp,asn,proxy_type", (code, response) =>
            {
                if (!Ok(code) || string.IsNullOrEmpty(response))
                {
                    return;
                }
                try
                {
                    var arr = JArray.Parse(response);
                    if (arr.Count == 0)
                    {
                        return;
                    }
                    var last = arr[0];
                    Patch($"/rest/v1/players?steamid=eq.{steamid}", new JObject
                    {
                        ["is_vpn"] = (bool)last["is_vpn"],
                        ["vpn_checked"] = true,
                        ["country"] = (string)last["country"],
                        ["country_code"] = (string)last["country_code"],
                        ["isp"] = (string)last["isp"],
                        ["asn"] = (string)last["asn"],
                        ["proxy_type"] = (string)last["proxy_type"]
                    }.ToString());
                }
                catch (Exception ex)
                {
                    PrintError($"Restore cached IP check failed for {ip}: {ex.Message}");
                }
            });
        }

        // Performs a single proxycheck.io lookup for an IP and stores the result in
        // ip_checks (history) and, when a steamid is given, on the players row.
        private void LookupIp(string ip, string steamid, string name, string source, Action<bool, JObject> done)
        {
            string url = string.IsNullOrEmpty(config.ProxyCheckKey)
                ? $"https://api.proxycheck.io/v2/{ip}?vpn=1&asn=1"
                : $"https://api.proxycheck.io/v2/{ip}?key={config.ProxyCheckKey}&vpn=1&asn=1&risk=1";

            webrequest.Enqueue(url, null, (code, response) =>
            {
                bool isVpn = false;
                string proxyType = null, country = null, countryCode = null, isp = null, asn = null;
                long risk = 0;

                try
                {
                    if (code == 200 && !string.IsNullOrEmpty(response))
                    {
                        var o = JObject.Parse(response);
                        var node = o[ip];
                        if (node != null)
                        {
                            string proxy = (string)node["proxy"];
                            string type = (string)node["type"];
                            isVpn = "yes".Equals(proxy, StringComparison.OrdinalIgnoreCase)
                                    || "VPN".Equals(type, StringComparison.OrdinalIgnoreCase)
                                    || "proxy".Equals(type, StringComparison.OrdinalIgnoreCase);
                            proxyType = type;
                            country = (string)node["country"];
                            countryCode = (string)node["country_code"];
                            isp = (string)node["isp"] ?? (string)node["organisation"];
                            asn = (string)node["asn"];
                            risk = GetLong(node as JObject, "risk") ?? 0;
                        }
                    }
                }
                catch (Exception ex)
                {
                    PrintError($"IP check parse error for {ip}: {ex.Message}");
                }

                // proxycheck.io without an API key returns no geo data at all (country
                // stays null). Fall back to the free ip-api.com so the panel still shows
                // a country and provider for the player.
                if (string.IsNullOrEmpty(country))
                {
                    LookupGeoFallback(ip, geo =>
                    {
                        var check = new JObject
                        {
                            ["steamid"] = steamid,
                            ["name"] = name,
                            ["ip"] = ip,
                            ["is_vpn"] = geo.isVpn,
                            ["proxy_type"] = string.IsNullOrEmpty(geo.proxyType) ? proxyType : geo.proxyType,
                            ["country"] = string.IsNullOrEmpty(geo.country) ? country : geo.country,
                            ["country_code"] = string.IsNullOrEmpty(geo.countryCode) ? countryCode : geo.countryCode,
                            ["isp"] = string.IsNullOrEmpty(geo.isp) ? isp : geo.isp,
                            ["asn"] = string.IsNullOrEmpty(geo.asn) ? asn : geo.asn,
                            ["risk"] = risk,
                            ["source"] = source,
                            ["created_at"] = DateTime.UtcNow.ToString("o", CultureInfo.InvariantCulture)
                        };
                        Post("/rest/v1/ip_checks", check.ToString());

                        if (!string.IsNullOrEmpty(steamid))
                        {
                            Patch($"/rest/v1/players?steamid=eq.{steamid}", new JObject
                            {
                                ["is_vpn"] = geo.isVpn,
                                ["vpn_checked"] = true,
                                ["country"] = check["country"],
                                ["country_code"] = check["country_code"],
                                ["isp"] = check["isp"],
                                ["asn"] = check["asn"],
                                ["proxy_type"] = check["proxy_type"]
                            }.ToString());
                        }

                        done?.Invoke(geo.isVpn, check);
                    });
                    return;
                }

                var check2 = new JObject
                {
                    ["steamid"] = steamid,
                    ["name"] = name,
                    ["ip"] = ip,
                    ["is_vpn"] = isVpn,
                    ["proxy_type"] = proxyType,
                    ["country"] = country,
                    ["country_code"] = countryCode,
                    ["isp"] = isp,
                    ["asn"] = asn,
                    ["risk"] = risk,
                    ["source"] = source,
                    ["created_at"] = DateTime.UtcNow.ToString("o", CultureInfo.InvariantCulture)
                };
                Post("/rest/v1/ip_checks", check2.ToString());

                if (!string.IsNullOrEmpty(steamid))
                {
                    Patch($"/rest/v1/players?steamid=eq.{steamid}", new JObject
                    {
                        ["is_vpn"] = isVpn,
                        ["vpn_checked"] = true,
                        ["country"] = country,
                        ["country_code"] = countryCode,
                        ["isp"] = isp,
                        ["asn"] = asn,
                        ["proxy_type"] = proxyType
                    }.ToString());
                }

                done?.Invoke(isVpn, check2);
            }, this, RequestMethod.GET, null, 10f);
        }

        // Free geo lookup (ip-api.com, no key required). Only used as a fallback when
        // proxycheck.io gave no country — the panel needs at least a flag + provider.
        private void LookupGeoFallback(string ip, Action<GeoResult> done)
        {
            var geo = new GeoResult();
            try
            {
                webrequest.Enqueue($"http://ip-api.com/json/{ip}?fields=status,country,countryCode,isp,as,proxy,hosting",
                    null, (code, response) =>
                    {
                        try
                        {
                            if (code == 200 && !string.IsNullOrEmpty(response))
                            {
                                var o = JObject.Parse(response);
                                if ((string)o["status"] == "success")
                                {
                                    geo.country = (string)o["country"];
                                    geo.countryCode = (string)o["countryCode"];
                                    geo.isp = (string)o["isp"];
                                    geo.asn = (string)o["as"];
                                    // ip-api flags hosting/proxy endpoints; treat them as a VPN signal.
                                    bool proxy = (bool?)o["proxy"] == true || (bool?)o["hosting"] == true;
                                    geo.isVpn = proxy;
                                    geo.proxyType = proxy ? "hosting" : null;
                                }
                            }
                        }
                        catch (Exception ex)
                        {
                            PrintError($"ip-api parse error for {ip}: {ex.Message}");
                        }
                        done?.Invoke(geo);
                    }, this, RequestMethod.GET, null, 8f);
            }
            catch (Exception ex)
            {
                PrintError($"ip-api request failed for {ip}: {ex.Message}");
                done?.Invoke(geo);
            }
        }

        private class GeoResult
        {
            public string country;
            public string countryCode;
            public string isp;
            public string asn;
            public bool isVpn;
            public string proxyType;
        }

        private static string FormatIpResult(JObject o)
        {
            return $"{GetStr(o, "country")} ({GetStr(o, "country_code")}) | {GetStr(o, "isp")} | risk={GetLong(o, "risk") ?? 0}";
        }

        #endregion

        #region Server heartbeat

        private int currentFps = 0;

        private void FpsLoop()
        {
            try
            {
                currentFps = Mathf.RoundToInt(1f / UnityEngine.Time.unscaledDeltaTime);
            }
            catch { }
            timer.Once(1f, FpsLoop);
        }

        private void Heartbeat()
        {
            var body = new JObject
            {
                ["id"] = 1,
                ["hostname"] = ConVar.Server.hostname,
                ["players_online"] = BasePlayer.activePlayerList.Count,
                ["max_players"] = ConVar.Server.maxplayers,
                ["fps"] = currentFps,
                ["last_heartbeat"] = DateTime.UtcNow.ToString("o", CultureInfo.InvariantCulture)
            };
            Post("/rest/v1/server_status?on_conflict=id", body.ToString(), upsert: true);
        }

        // Feeds the dashboard online chart: one row every 5 minutes.
        private void LogOnlineHistory()
        {
            if (!IsConfigured())
            {
                return;
            }
            var body = new JObject
            {
                ["players_online"] = BasePlayer.activePlayerList.Count,
                ["created_at"] = DateTime.UtcNow.ToString("o", CultureInfo.InvariantCulture)
            };
            Post("/rest/v1/online_history", body.ToString());
        }

        #endregion

        #region Commands polling (site -> plugin)

        private void PollCommands()
        {
            if (!IsConfigured())
            {
                return;
            }
            Get("/rest/v1/commands?select=id,command,steamid,ip,hwid,name,reason,message,duration_minutes,admin&status=eq.pending&order=id.asc&limit=10", (code, response) =>
            {
                if (!Ok(code) || string.IsNullOrEmpty(response))
                {
                    return;
                }
                try
                {
                    var arr = JArray.Parse(response);
                    foreach (JObject cmd in arr)
                    {
                        try
                        {
                            ExecuteCommand(cmd);
                        }
                        catch (Exception ex)
                        {
                            PrintError($"Failed to execute panel command: {ex.Message}");
                            long failId = GetLong(cmd, "id") ?? 0;
                            if (failId > 0)
                            {
                                Patch($"/rest/v1/commands?id=eq.{failId}", new JObject
                                {
                                    ["status"] = "failed",
                                    ["executed_at"] = DateTime.UtcNow.ToString("o", CultureInfo.InvariantCulture),
                                    ["result"] = "Plugin error: " + ex.Message
                                }.ToString());
                            }
                        }
                    }
                }
                catch (Exception ex)
                {
                    PrintError($"PollCommands parse error: {ex.Message}");
                }
            });
        }

        private void ExecuteCommand(JObject cmd)
        {
            long id = GetLong(cmd, "id") ?? 0;
            string command = (GetStr(cmd, "command") ?? string.Empty).ToLowerInvariant();
            string steamid = GetStr(cmd, "steamid") ?? string.Empty;
            string ip = GetStr(cmd, "ip") ?? string.Empty;
            string hwid = GetStr(cmd, "hwid") ?? string.Empty;
            string name = GetStr(cmd, "name") ?? string.Empty;
            string reason = GetStr(cmd, "reason") ?? "No reason";
            string message = GetStr(cmd, "message") ?? string.Empty;
            long? duration = GetLong(cmd, "duration_minutes");
            string admin = GetStr(cmd, "admin") ?? "panel";

            string result;
            bool done;
            bool async = false;

            switch (command)
            {
                case "kick":
                    {
                        BasePlayer p = FindPlayer(steamid, name);
                        if (p == null)
                        {
                            done = false;
                            result = "Player is not online";
                        }
                        else
                        {
                            PInfo iP = GetInfo(p);
                            if (iP != null)
                            {
                                iP.Kick(reason);
                                InsertKick(iP, reason, admin);
                                done = true;
                                result = $"Kicked {iP.Name} ({iP.Id}): {reason}";
                            }
                            else
                            {
                                done = false;
                                result = "Player is not online";
                            }
                        }
                        break;
                    }

                case "ban":
                    {
                        BasePlayer p = FindPlayer(steamid, name);
                        PInfo bPlayer = GetInfo(p);
                        string bSteamid = !string.IsNullOrEmpty(steamid) ? steamid : bPlayer?.Id;
                        string bIp = !string.IsNullOrEmpty(ip) ? ip : (bPlayer != null ? CleanIp(bPlayer.Address) : null);
                        string bHwid = !string.IsNullOrEmpty(hwid) ? hwid : GetHwid(bPlayer);
                        string bName = !string.IsNullOrEmpty(name) ? name : bPlayer?.Name;

                        var ban = new JObject
                        {
                            ["steamid"] = bSteamid,
                            ["ip"] = bIp,
                            ["hwid"] = bHwid,
                            ["name"] = bName,
                            ["reason"] = reason,
                            ["admin"] = admin,
                            ["active"] = true,
                            ["created_at"] = DateTime.UtcNow.ToString("o", CultureInfo.InvariantCulture),
                            ["duration_minutes"] = duration,
                            ["expires_at"] = duration.HasValue
                                ? DateTime.UtcNow.AddMinutes(duration.Value).ToString("o", CultureInfo.InvariantCulture)
                                : null
                        };
                        Post("/rest/v1/bans", ban.ToString());
                        InsertAlert("ban", $"Banned {bName} ({bSteamid}) for {(duration.HasValue ? duration + " min" : "permanent")}: {reason}");

                        if (p != null)
                        {
                            PInfo iP = GetInfo(p);
                            if (iP != null)
                            {
                                iP.Kick(string.Format(lang.GetMessage("BannedMessage", this, iP.Id), reason));
                            }
                            else
                            {
                                p.Kick("You are banned on this server. Reason: " + reason);
                            }
                        }
                        done = true;
                        result = $"Banned {bName} ({bSteamid} / {bIp}) for {(duration.HasValue ? duration + " min" : "permanent")}: {reason}";
                        break;
                    }

                case "unban":
                    {
                        var orParts = new List<string>();
                        if (!string.IsNullOrEmpty(steamid)) orParts.Add($"steamid.eq.{steamid}");
                        if (!string.IsNullOrEmpty(ip)) orParts.Add($"ip.eq.{ip}");
                        if (!string.IsNullOrEmpty(hwid)) orParts.Add($"hwid.eq.{hwid}");
                        if (orParts.Count == 0)
                        {
                            done = false;
                            result = "Unban requires a steamid, ip or hwid";
                            break;
                        }

                        Patch($"/rest/v1/bans?active=eq.true&or=(" + string.Join(",", orParts) + ")", new JObject
                        {
                            ["active"] = false,
                            ["unbanned_by"] = admin,
                            ["unbanned_at"] = DateTime.UtcNow.ToString("o", CultureInfo.InvariantCulture)
                        }.ToString());

                        done = true;
                        result = $"Unbanned {steamid}{(string.IsNullOrEmpty(ip) ? "" : " / " + ip)}";
                        break;
                    }

                case "mute":
                    {
                        BasePlayer p = FindPlayer(steamid, name);
                        PInfo mPlayer = GetInfo(p);
                        string mSteamid = !string.IsNullOrEmpty(steamid) ? steamid : mPlayer?.Id;
                        string mName = !string.IsNullOrEmpty(name) ? name : mPlayer?.Name;

                        if (string.IsNullOrEmpty(mSteamid))
                        {
                            done = false;
                            result = "Cannot mute: player is not online and no steamid was provided";
                            break;
                        }

                        var mute = new JObject
                        {
                            ["steamid"] = mSteamid,
                            ["name"] = mName,
                            ["reason"] = reason,
                            ["admin"] = admin,
                            ["active"] = true,
                            ["created_at"] = DateTime.UtcNow.ToString("o", CultureInfo.InvariantCulture),
                            ["duration_minutes"] = duration,
                            ["expires_at"] = duration.HasValue
                                ? DateTime.UtcNow.AddMinutes(duration.Value).ToString("o", CultureInfo.InvariantCulture)
                                : null
                        };
                        Post("/rest/v1/mutes", mute.ToString());
                        if (!string.IsNullOrEmpty(mSteamid))
                        {
                            mutedPlayers.Add(mSteamid);
                        }
                        done = true;
                        result = $"Muted {mName} ({mSteamid}) for {(duration.HasValue ? duration + " min" : "permanent")}: {reason}";
                        break;
                    }

                case "unmute":
                    {
                        if (string.IsNullOrEmpty(steamid))
                        {
                            done = false;
                            result = "Unmute requires a steamid";
                            break;
                        }

                        Patch($"/rest/v1/mutes?active=eq.true&steamid=eq.{steamid}", new JObject
                        {
                            ["active"] = false,
                            ["unmuted_by"] = admin,
                            ["unmuted_at"] = DateTime.UtcNow.ToString("o", CultureInfo.InvariantCulture)
                        }.ToString());
                        mutedPlayers.Remove(steamid);
                        done = true;
                        result = $"Unmuted {steamid}";
                        break;
                    }

                case "say":
                    {
                        BasePlayer p = FindPlayer(steamid, name);
                        if (p == null)
                        {
                            done = false;
                            result = "Player is not online";
                        }
                        else
                        {
                            SendMessage(p, message);
                            PInfo iP = GetInfo(p);
                            done = true;
                            result = $"Private message sent to {(iP != null ? iP.Name : p.displayName)}";
                        }
                        break;
                    }

                case "broadcast":
                    {
                        try
                        {
                            string avatar = config.AvatarSteamId;
                            foreach (BasePlayer bp in BasePlayer.activePlayerList)
                            {
                                try
                                {
                                    bp.SendConsoleCommand("chat.add", 0, avatar, message);
                                }
                                catch { }
                            }
                        }
                        catch
                        {
                            ConsoleSystem.Run(ConsoleSystem.Option.Server, "say " + message, Array.Empty<string>());
                        }
                        done = true;
                        result = "Broadcast: " + message;
                        break;
                    }

                case "console":
                    {
                        if (!config.AllowConsoleCommands)
                        {
                            done = false;
                            result = "Console command execution is disabled in the plugin config";
                        }
                        else
                        {
                            try
                            {
                                ConsoleSystem.Run(ConsoleSystem.Option.Server, message, Array.Empty<string>());
                                done = true;
                                result = "Executed: " + message;
                            }
                            catch (Exception ex)
                            {
                                done = false;
                                result = "Console error: " + ex.Message;
                            }
                        }
                        break;
                    }

                case "checkip":
                    {
                        // Manual IP lookup from the panel. If no IP is given, fall back to
                        // the online player's address (steamid/name).
                        string checkIp = !string.IsNullOrEmpty(ip) ? ip : null;
                        if (string.IsNullOrEmpty(checkIp))
                        {
                            PInfo iP = GetInfo(FindPlayer(steamid, name));
                            checkIp = CleanIp(iP?.Address ?? string.Empty);
                        }

                        if (string.IsNullOrEmpty(checkIp))
                        {
                            done = false;
                            result = "checkip needs an IP address or an online player";
                            break;
                        }

                        done = true;
                        result = "Checking " + checkIp + "...";
                        LookupIp(checkIp, steamid, name, "manual", (isVpn, check) =>
                        {
                            Patch($"/rest/v1/commands?id=eq.{id}", new JObject
                            {
                                ["status"] = "done",
                                ["executed_at"] = DateTime.UtcNow.ToString("o", CultureInfo.InvariantCulture),
                                ["result"] = $"{checkIp}: {(isVpn ? "VPN / PROXY" : "clean")} | {FormatIpResult(check)}"
                            }.ToString());
                        });
                        break;
                    }

                case "check":
                    {
                        // "Call for verification" from the site: opens a private channel
                        // between the admin and the player and shows an in-game notice.
                        BasePlayer p = FindPlayer(steamid, name);
                        if (p == null)
                        {
                            done = false;
                            result = "Player is not online";
                            break;
                        }

                        PInfo iP = GetInfo(p);
                        string cSteamid = !string.IsNullOrEmpty(steamid) ? steamid : iP?.Id;
                        string cName = !string.IsNullOrEmpty(name) ? name : iP?.Name;

                        async = true;
                        StartCheck(cSteamid, cName, admin, checkId =>
                        {
                            if (!checkId.HasValue)
                            {
                                Patch($"/rest/v1/commands?id=eq.{id}", new JObject
                                {
                                    ["status"] = "failed",
                                    ["executed_at"] = DateTime.UtcNow.ToString("o", CultureInfo.InvariantCulture),
                                    ["result"] = "Player is already in a verification session"
                                }.ToString());
                                return;
                            }

                            AddCheckEvent(checkId.Value, "event", $"{admin} called {cName} for verification");
                            ShowCheckNotice(p, admin);

                            Patch($"/rest/v1/commands?id=eq.{id}", new JObject
                            {
                                ["status"] = "done",
                                ["executed_at"] = DateTime.UtcNow.ToString("o", CultureInfo.InvariantCulture),
                                ["result"] = $"Called {cName} ({cSteamid}) for verification, session #{checkId.Value}"
                            }.ToString());
                        });
                        done = true;
                        result = "Starting verification session…";
                        break;
                    }

                case "checkshow":
                    {
                        // Site button "Показать табличку": re-shows the in-game notice.
                        BasePlayer p = FindPlayer(steamid, name);
                        if (p == null)
                        {
                            done = false;
                            result = "Player is not online";
                            break;
                        }

                        ShowCheckNotice(p, admin);
                        done = true;
                        result = $"Notice shown to {(GetInfo(p)?.Name ?? steamid)}";
                        break;
                    }

                case "checkmsg":
                    {
                        // Admin's message inside the verification chat.
                        BasePlayer p = FindPlayer(steamid, name);
                        if (p == null)
                        {
                            done = false;
                            result = "Player is not online";
                            break;
                        }

                        long? msgCheckId = GetActiveCheckId(steamid);
                        if (!msgCheckId.HasValue)
                        {
                            done = false;
                            result = "No active verification session for this player";
                            break;
                        }

                        AddCheckEvent(msgCheckId.Value, "msg_admin", message);
                        SendMessage(p, $"<color=#8393cd>[Check]</color> {message}");
                        done = true;
                        result = "Message delivered";
                        break;
                    }

                case "checkverdict":
                    {
                        // Admin's verdict from the site: "clean" closes the session,
                        // "banned" closes it and bans the player.
                        if (string.IsNullOrEmpty(steamid))
                        {
                            done = false;
                            result = "Verdict requires a steamid";
                            break;
                        }

                        string verdict = (message ?? reason ?? string.Empty).ToLowerInvariant();
                        if (verdict != "clean" && verdict != "banned")
                        {
                            done = false;
                            result = "Unknown verdict: " + verdict;
                            break;
                        }

                        CloseCheck(steamid, verdict, admin);

                        BasePlayer verdictPlayer = FindPlayer(steamid, name);
                        DestroyCheckNotice(verdictPlayer);

                        if (verdict == "banned")
                        {
                            PInfo bPlayer = GetInfo(verdictPlayer);
                            var ban = new JObject
                            {
                                ["steamid"] = steamid,
                                ["ip"] = !string.IsNullOrEmpty(ip) ? ip : (bPlayer != null ? CleanIp(bPlayer.Address) : null),
                                ["hwid"] = !string.IsNullOrEmpty(hwid) ? hwid : GetHwid(bPlayer),
                                ["name"] = !string.IsNullOrEmpty(name) ? name : bPlayer?.Name,
                                ["reason"] = reason,
                                ["admin"] = admin,
                                ["active"] = true,
                                ["created_at"] = DateTime.UtcNow.ToString("o", CultureInfo.InvariantCulture)
                            };
                            Post("/rest/v1/bans", ban.ToString());
                            InsertAlert("ban", $"Check verdict: banned {name ?? steamid}: {reason}");

                            if (verdictPlayer != null)
                            {
                                verdictPlayer.Kick("You are banned on this server. Reason: " + reason);
                            }
                            done = true;
                            result = $"Verdict: BANNED {steamid}: {reason}";
                        }
                        else
                        {
                            done = true;
                            result = $"Verdict: CLEAN {steamid}";
                        }
                        break;
                    }

                default:
                    done = false;
                    result = "Unknown command type: " + command;
                    break;
            }

            // Async commands (e.g. "check") patch their own status from the callback.
            if (async)
            {
                LogCommand($"{admin} -> {command}: {result}");
                return;
            }

            Patch($"/rest/v1/commands?id=eq.{id}", new JObject
            {
                ["status"] = done ? "done" : "failed",
                ["executed_at"] = DateTime.UtcNow.ToString("o", CultureInfo.InvariantCulture),
                ["result"] = result
            }.ToString());

            LogCommand($"{admin} -> {command}: {result}");
        }

        #endregion

        #region Check system (verification sessions)

        private const string CheckLayer = "UI_RAP_CheckNotice";

        // steamid -> active check id. Mirrors the "checks" table so command
        // handling does not need an extra round trip for every event.
        private readonly Dictionary<string, long> activeChecks = new Dictionary<string, long>();

        // Reload-safe: pick up sessions that were started before the plugin reloaded.
        private void LoadActiveChecks()
        {
            Get("/rest/v1/checks?status=eq.active&select=id,steamid", (code, response) =>
            {
                if (!Ok(code) || string.IsNullOrEmpty(response))
                {
                    return;
                }
                try
                {
                    var arr = JArray.Parse(response);
                    foreach (JObject o in arr)
                    {
                        long cid = GetLong(o, "id") ?? 0;
                        string sid = GetStr(o, "steamid");
                        if (cid > 0 && !string.IsNullOrEmpty(sid))
                        {
                            activeChecks[sid] = cid;
                        }
                    }
                    if (activeChecks.Count > 0)
                    {
                        Puts($"Resumed {activeChecks.Count} active verification session(s).");
                    }
                }
                catch (Exception ex)
                {
                    PrintError($"LoadActiveChecks parse error: {ex.Message}");
                }
            });
        }

        // Creates a verification session for the player. Calls back with the new
        // check id, or null when a session is already running for this player.
        private void StartCheck(string steamid, string name, string admin, Action<long?> done)
        {
            if (string.IsNullOrEmpty(steamid))
            {
                done?.Invoke(null);
                return;
            }

            if (activeChecks.ContainsKey(steamid))
            {
                done?.Invoke(null);
                return;
            }

            var body = new JObject
            {
                ["steamid"] = steamid,
                ["name"] = name,
                ["admin"] = admin ?? "panel",
                ["status"] = "active",
                ["shown"] = false,
                ["created_at"] = DateTime.UtcNow.ToString("o", CultureInfo.InvariantCulture)
            };

            var headers = AuthHeaders();
            headers["Prefer"] = "return=representation";
            webrequest.Enqueue(Url("/rest/v1/checks"), body.ToString(), (code, response) =>
            {
                long? newId = null;
                try
                {
                    if (Ok(code) && !string.IsNullOrEmpty(response))
                    {
                        var arr = JArray.Parse(response);
                        if (arr.Count > 0)
                        {
                            newId = GetLong((JObject)arr[0], "id");
                        }
                    }
                    else
                    {
                        PrintWarning($"StartCheck insert failed ({code}): {response}");
                    }
                }
                catch (Exception ex)
                {
                    PrintError($"StartCheck parse error: {ex.Message}");
                }

                if (newId.HasValue && newId.Value > 0)
                {
                    activeChecks[steamid] = newId.Value;
                    InsertAlert("check", $"{admin ?? "panel"} started a check on {name ?? steamid}");
                }

                done?.Invoke(newId);
            }, this, RequestMethod.POST, headers, 10f);
        }

        private long? GetActiveCheckId(string steamid)
        {
            if (string.IsNullOrEmpty(steamid))
            {
                return null;
            }
            return activeChecks.TryGetValue(steamid, out long id) ? (long?)id : null;
        }

        private void AddCheckEvent(long checkId, string kind, string text)
        {
            if (checkId <= 0 || string.IsNullOrEmpty(text))
            {
                return;
            }
            var body = new JObject
            {
                ["check_id"] = checkId,
                ["kind"] = kind,
                ["text"] = text,
                ["created_at"] = DateTime.UtcNow.ToString("o", CultureInfo.InvariantCulture)
            };
            Post("/rest/v1/check_events", body.ToString());
        }

        // marks the session as finished ("clean" or "banned") and drops the cache entry
        private void CloseCheck(string steamid, string verdict, string admin)
        {
            if (string.IsNullOrEmpty(steamid))
            {
                return;
            }

            long? checkId = GetActiveCheckId(steamid);
            activeChecks.Remove(steamid);

            var body = new JObject
            {
                ["status"] = verdict,
                ["closed_at"] = DateTime.UtcNow.ToString("o", CultureInfo.InvariantCulture)
            };

            string filter = checkId.HasValue
                ? $"?id=eq.{checkId.Value}"
                : $"?steamid=eq.{steamid}&status=eq.active";
            Patch("/rest/v1/checks" + filter, body.ToString());

            if (checkId.HasValue)
            {
                AddCheckEvent(checkId.Value, "event", $"{admin}: verdict {verdict}");
            }
        }

        // The in-game "you have been called for verification" notice (site button
        // "Показать табличку"). RustApp-style: full screen dim + centered text.
        private void ShowCheckNotice(BasePlayer player, string admin)
        {
            if (player == null || !IsConfigured())
            {
                return;
            }

            string sid = player.UserIDString;
            long checkId = GetActiveCheckId(sid) ?? 0;

            DestroyCheckNotice(player);

            CuiElementContainer container = new CuiElementContainer();

            // RustApp-style full-screen notice: dark overlay + centered text.
            // No close button: the notice stays until the admin issues a verdict.
            container.Add(new CuiButton
            {
                RectTransform = { AnchorMin = "0 0.5", AnchorMax = "1 1", OffsetMin = "-500 -500", OffsetMax = "500 500" },
                Button = { Color = HexToRustFormat("#1C1C1C"), Sprite = "assets/content/ui/gameui/attackheli/compass/ui.soft.radial.png" },
                Text = { Text = string.Empty, Align = TextAnchor.MiddleCenter }
            }, "Under", CheckLayer);

            container.Add(new CuiLabel
            {
                RectTransform = { AnchorMin = "0 0", AnchorMax = "1 1", OffsetMax = "0 0" },
                Text = { Text = lang.GetMessage("Check.NoticeText", this, sid).Replace("{0}", config.ContactMessage).Replace("{1}", config.ContactCommand), Align = TextAnchor.MiddleCenter, Font = "robotocondensed-regular.ttf", FontSize = 16 }
            }, CheckLayer);

            CuiHelper.AddUi(player, container);

            // RustApp plays the invite notice sound when the check window appears.
            try
            {
                var effect = new Effect("assets/bundled/prefabs/fx/invite_notice.prefab", player, 0, new Vector3(), new Vector3());
                EffectNetwork.Send(effect, player.Connection);
            }
            catch { }

            if (checkId > 0)
            {
                Patch($"/rest/v1/checks?id=eq.{checkId}", new JObject { ["shown"] = true }.ToString());
                AddCheckEvent(checkId, "event", $"notice shown by {admin}");
            }
        }

        private void DestroyCheckNotice(BasePlayer player)
        {
            if (player == null)
            {
                return;
            }
            CuiHelper.DestroyUi(player, CheckLayer);
        }

        private void DestroyAllCheckNotices()
        {
            foreach (BasePlayer player in BasePlayer.activePlayerList)
            {
                CuiHelper.DestroyUi(player, CheckLayer);
            }
        }

        [ConsoleCommand("rap.checkclose")]
        private void CmdCheckClose(ConsoleSystem.Arg args)
        {
            var player = args.Player();
            if (player == null)
            {
                return;
            }
            DestroyCheckNotice(player);
        }

        #endregion

        #region Player lookup

        private class PInfo
        {
            public string Id;
            public string Name;
            public string Address;
            public int Ping;
            public BasePlayer Player;

            public void Kick(string reason)
            {
                if (Player != null)
                {
                    Player.Kick(reason);
                }
            }
        }

        private PInfo GetInfo(BasePlayer player)
        {
            if (player == null)
            {
                return null;
            }
            try
            {
                var info = new PInfo { Player = player };
                try { info.Id = player.UserIDString; } catch { }
                try { info.Name = player.net != null && player.net.connection != null ? player.net.connection.username : player.displayName; } catch { try { info.Name = player.displayName; } catch { } }
                try
                {
                    if (player.Connection != null)
                    {
                        info.Address = player.Connection.ipaddress;
                        info.Ping = GetPing(player.Connection);
                    }
                }
                catch { }
                if (string.IsNullOrEmpty(info.Id))
                {
                    return null;
                }
                return info;
            }
            catch
            {
                return null;
            }
        }

        private static int GetPing(Network.Connection connection)
        {
            if (connection == null)
            {
                return 0;
            }
            try
            {
                // Rust's server keeps an average RTT per connection. The API moved
                // between game versions (Net.sv -> Server.sv), so try both.
                var netType = Type.GetType("Network.Net, Assembly-CSharp")
                              ?? Type.GetType("Net, Assembly-CSharp")
                              ?? Type.GetType("Server, Assembly-CSharp");
                if (netType != null)
                {
                    object svInstance = null;
                    var field = netType.GetField("sv", BindingFlags.Public | BindingFlags.Static);
                    if (field != null)
                    {
                        svInstance = field.GetValue(null);
                    }
                    else
                    {
                        var prop = netType.GetProperty("sv", BindingFlags.Public | BindingFlags.Static);
                        if (prop != null)
                        {
                            svInstance = prop.GetValue(null, null);
                        }
                    }
                    if (svInstance != null)
                    {
                        var method = svInstance.GetType().GetMethod("GetAveragePing", new[] { typeof(Network.Connection) });
                        if (method != null)
                        {
                            object result = method.Invoke(svInstance, new object[] { connection });
                            return result is int ping ? ping : Convert.ToInt32(result);
                        }
                    }
                }

                // Fallback: the connection itself exposes latency in recent Rust builds.
                var connPing = connection.GetType().GetProperty("ping", BindingFlags.Public | BindingFlags.Instance);
                if (connPing != null)
                {
                    object result = connPing.GetValue(connection, null);
                    if (result != null)
                    {
                        return Convert.ToInt32(result);
                    }
                }
            }
            catch { }
            return 0;
        }

        // Refreshes ping and map position for every online player so the panel always
        // shows a live value instead of the number that was written when they joined.
        private void RefreshPings()
        {
            if (!IsConfigured())
            {
                return;
            }
            try
            {
                foreach (BasePlayer player in BasePlayer.activePlayerList)
                {
                    if (player == null || player.Connection == null)
                    {
                        continue;
                    }
                    int ping = GetPing(player.Connection);
                    string steamid = null;
                    try { steamid = player.UserIDString; } catch { }
                    if (string.IsNullOrEmpty(steamid))
                    {
                        continue;
                    }

                    var body = new JObject();
                    if (ping > 0)
                    {
                        body["ping"] = ping;
                    }
                    // Map coordinates for the live map view.
                    try
                    {
                        var pos = player.transform.position;
                        body["pos_x"] = Mathf.RoundToInt(pos.x);
                        body["pos_z"] = Mathf.RoundToInt(pos.z);
                    }
                    catch { }

                    if (body.Count > 0)
                    {
                        Patch($"/rest/v1/players?steamid=eq.{steamid}&online=eq.true", body.ToString());
                    }
                }

                // Sleeping players (bodies) are tracked separately so the panel can show
                // who is logged out but still has a bag/body on the map.
                RefreshSleepers();
            }
            catch { }
        }

        // Records all sleeping bodies so the panel can show "sleepers" like RustApp does.
        private void RefreshSleepers()
        {
            try
            {
                foreach (BasePlayer player in BasePlayer.sleepingPlayerList)
                {
                    if (player == null)
                    {
                        continue;
                    }
                    string steamid = null;
                    try { steamid = player.userID.ToString(); } catch { }
                    if (string.IsNullOrEmpty(steamid))
                    {
                        continue;
                    }
                    string name = null;
                    try { name = player.displayName; } catch { }

                    int x = 0, z = 0;
                    try
                    {
                        var pos = player.transform.position;
                        x = Mathf.RoundToInt(pos.x);
                        z = Mathf.RoundToInt(pos.z);
                    }
                    catch { }

                    var body = new JObject
                    {
                        ["steamid"] = steamid,
                        ["name"] = name,
                        ["pos_x"] = x,
                        ["pos_z"] = z,
                        ["last_seen"] = DateTime.UtcNow.ToString("o", CultureInfo.InvariantCulture)
                    };
                    Post("/rest/v1/sleepers?on_conflict=steamid", body.ToString(), upsert: true);
                }
            }
            catch { }
        }

        private void SendMessage(BasePlayer player, string message)
        {
            if (player == null || string.IsNullOrEmpty(message))
            {
                return;
            }
            try
            {
                player.SendConsoleCommand("chat.add", 0, config.AvatarSteamId, message);
            }
            catch
            {
                try
                {
                    SendReply(player, message);
                }
                catch { }
            }
        }

        private static string GetHwid(PInfo iPlayer)
        {
            if (iPlayer?.Player == null)
            {
                return string.Empty;
            }
            try
            {
                var prop = iPlayer.Player.GetType().GetProperty("Hwid");
                object value = prop?.GetValue(iPlayer.Player, null);
                return value?.ToString() ?? string.Empty;
            }
            catch
            {
                return string.Empty;
            }
        }

        private PInfo FindTarget(string query)
        {
            if (string.IsNullOrEmpty(query))
            {
                return null;
            }
            try
            {
                BasePlayer bp = Player.FindById(query) as BasePlayer;
                if (bp == null)
                {
                    bp = Player.Find(query) as BasePlayer;
                }
                return GetInfo(bp);
            }
            catch { }
            return null;
        }

        private BasePlayer FindPlayer(string steamidOrName, string name)
        {
            string query = !string.IsNullOrEmpty(steamidOrName) ? steamidOrName : name;
            if (string.IsNullOrEmpty(query))
            {
                return null;
            }
            try
            {
                BasePlayer bp = Player.FindById(query) as BasePlayer;
                if (bp == null)
                {
                    bp = Player.Find(query) as BasePlayer;
                }
                return bp;
            }
            catch { }
            return null;
        }

        #endregion

        private void SendReportFromUi(BasePlayer player, string targetId, string reason)
        {
            if (player == null || !IsConfigured() || string.IsNullOrEmpty(targetId) || string.IsNullOrEmpty(reason))
            {
                return;
            }

            PInfo reporterPlayer = GetInfo(player);
            if (reporterPlayer == null)
            {
                return;
            }

            string steamid = reporterPlayer.Id;
            long now = ToUnixTime(DateTime.UtcNow);
            if (lastReportTime.TryGetValue(steamid, out long last) && now - last < (long)config.ReportCooldown)
            {
                SoundToast(player, string.Format(lang.GetMessage("ReportCooldown", this, steamid), Mathf.CeilToInt(config.ReportCooldown - (now - last))), 1);
                return;
            }

            lastReportTime[steamid] = now;

            BasePlayer target = null;
            try
            {
                target = BasePlayer.Find(targetId);
            }
            catch
            {
            }

            var report = new JObject
            {
                ["reporter_steamid"] = steamid,
                ["reporter_name"] = reporterPlayer.Name,
                ["target_steamid"] = targetId,
                ["target_name"] = target != null ? target.displayName : targetId,
                ["reason"] = reason,
                ["source"] = "menu",
                ["status"] = "pending",
                ["created_at"] = DateTime.UtcNow.ToString("o", CultureInfo.InvariantCulture)
            };
            Post("/rest/v1/reports", report.ToString());
            InsertAlert("report", $"Report: {reporterPlayer.Name} reported {(target != null ? target.displayName : targetId)} - {reason}");

            CuiHelper.DestroyUi(player, ReportLayer);

            SoundToast(player, lang.GetMessage("ReportSent", this, steamid), 2);
            LogCommand($"Report from {reporterPlayer.Name}: {targetId} - {reason}");
        }

        #region Chat, kills, mutes enforcement

        private object OnPlayerChat(BasePlayer player, string message, ConVar.Chat.ChatChannel channel)
        {
            if (player == null || !IsConfigured())
            {
                return null;
            }

            if (channel is not (ConVar.Chat.ChatChannel.Global or ConVar.Chat.ChatChannel.Team or ConVar.Chat.ChatChannel.Local))
            {
                return null;
            }

            PInfo iPlayer = GetInfo(player);
            if (iPlayer == null)
            {
                return null;
            }

            string steamid = iPlayer.Id;

            if (config.CollectChat)
            {
                try
                {
                    InsertChatLog(iPlayer, message);
                }
                catch { }
            }

            // Everything the player says while he is in a verification session
            // is streamed into the admin's check chat on the site.
            long? activeCheck = GetActiveCheckId(steamid);
            if (activeCheck.HasValue)
            {
                AddCheckEvent(activeCheck.Value, "chat", message);
            }

            if (config.SupportMutes && mutedPlayers.Contains(steamid))
            {
                try
                {
                    Get($"/rest/v1/mutes?active=eq.true&steamid=eq.{steamid}&order=id.desc&limit=1&select=reason,expires_at", (code, response) =>
                    {
                        if (Ok(code) && !string.IsNullOrEmpty(response))
                        {
                            try
                            {
                                var arr = JArray.Parse(response);
                                if (arr.Count > 0)
                                {
                                    var m = arr[0];
                                    DateTime? expDate = ParseUtcDate(m["expires_at"]);
                                    if (expDate.HasValue && expDate.Value <= DateTime.UtcNow)
                                    {
                                        mutedPlayers.Remove(steamid);

                                        Patch("/rest/v1/mutes?id=eq." + m["id"], new JObject { ["active"] = false }.ToString());
                                        return;
                                    }
                                    string r = GetStr((JObject)m, "reason");
                                    if (!string.IsNullOrEmpty(r))
                                    {
                                        SendMessage(player, string.Format(lang.GetMessage("MutedMessage", this, steamid), r));
                                    }
                                }
                            }
                            catch { }
                        }
                    });
                }
                catch { }
                return true;
            }

            return null;
        }

        private void OnEntityDeath(BaseCombatEntity entity, HitInfo info)
        {
            if (!IsConfigured() || !config.CollectKills || entity == null || info == null)
            {
                return;
            }

            try
            {
                BasePlayer victim = entity as BasePlayer;
                if (victim == null)
                {
                    return;
                }
                PInfo victimPlayer = GetInfo(victim);
                if (victimPlayer == null)
                {
                    return;
                }
                BasePlayer attacker = info.InitiatorPlayer;
                if (attacker == null || attacker == victim)
                {
                    return;
                }
                PInfo attackerPlayer = GetInfo(attacker);
                if (attackerPlayer == null)
                {
                    return;
                }

                string weapon = "unknown";
                try
                {
                    if (info.Weapon != null)
                    {
                        weapon = info.Weapon.ShortPrefabName;
                    }
                    else if (info.WeaponPrefab != null)
                    {
                        weapon = info.WeaponPrefab.ShortPrefabName;
                    }
                }
                catch { }

                float distance = Vector3.Distance(attacker.transform.position, victim.transform.position);

                bool headshot = false;
                try { headshot = info.isHeadshot; } catch { }

                var body = new JObject
                {
                    ["attacker_steamid"] = attackerPlayer.Id,
                    ["attacker_name"] = attackerPlayer.Name,
                    ["victim_steamid"] = victimPlayer.Id,
                    ["victim_name"] = victimPlayer.Name,
                    ["weapon"] = weapon,
                    ["distance"] = Math.Round(distance, 1),
                    ["headshot"] = headshot,
                    ["created_at"] = DateTime.UtcNow.ToString("o", CultureInfo.InvariantCulture)
                };
                Post("/rest/v1/kills", body.ToString());

                // Stream the kill into any active verification session either player is in.
                long? attackerCheck = GetActiveCheckId(attackerPlayer.Id);
                if (attackerCheck.HasValue)
                {
                    AddCheckEvent(attackerCheck.Value, "kill", $"killed {victimPlayer.Name} ({weapon}, {Math.Round(distance)}m)");
                }
                long? victimCheck = GetActiveCheckId(victimPlayer.Id);
                if (victimCheck.HasValue)
                {
                    AddCheckEvent(victimCheck.Value, "death", $"killed by {attackerPlayer.Name} ({weapon}, {Math.Round(distance)}m)");
                }
            }
            catch { }
        }

        private void RefreshMuteCache(string steamid)
        {
            if (string.IsNullOrEmpty(steamid))
            {
                return;
            }
            Get($"/rest/v1/mutes?active=eq.true&steamid=eq.{steamid}&order=id.desc&limit=1&select=id,expires_at", (code, response) =>
            {
                bool muted = false;
                try
                {
                        if (Ok(code) && !string.IsNullOrEmpty(response))
                        {
                            var arr = JArray.Parse(response);
                            if (arr.Count > 0)
                            {
                                DateTime? expDate = ParseUtcDate(arr[0]["expires_at"]);
                                if (!expDate.HasValue || expDate.Value > DateTime.UtcNow)
                                {
                                    muted = true;
                                }
                                else
                                {
                                    Patch("/rest/v1/mutes?id=eq." + arr[0]["id"], new JObject { ["active"] = false }.ToString());
                                }
                            }
                        }
                }
                catch { }

                if (muted)
                {
                    mutedPlayers.Add(steamid);
                }
                else
                {
                    mutedPlayers.Remove(steamid);
                }
            });
        }

        // Reload-safe muting: pulls every active mute into the in-memory cache so
        // players who were muted before the plugin reloaded stay muted, and keeps
        // the cache fresh for players that are already online when a mute arrives.
        private void RefreshAllMutes()
        {
            if (!IsConfigured() || !config.SupportMutes)
            {
                return;
            }

            foreach (BasePlayer p in BasePlayer.activePlayerList)
            {
                try
                {
                    RefreshMuteCache(p.UserIDString);
                }
                catch { }
            }
        }

        #endregion

        #region Reports (/report and F7)

        [ChatCommand("report")]
        private void CmdReport(BasePlayer player, string command, string[] args)
        {
            CmdReportInternal(player, command, args);
        }

        [ChatCommand("reports")]
        private void CmdReports(BasePlayer player, string command, string[] args)
        {
            CmdReportInternal(player, command, args);
        }

        private void CmdReportInternal(BasePlayer player, string command, string[] args)
        {
            if (!config.ReportCommands.Contains(command))
            {
                return;
            }
            if (player == null)
            {
                return;
            }
            PInfo reporterPlayer = GetInfo(player);
            if (reporterPlayer == null)
            {
                return;
            }

            string steamid = reporterPlayer.Id;
            long now = ToUnixTime(DateTime.UtcNow);
            if (lastReportTime.TryGetValue(steamid, out long last) && now - last < config.ReportCooldown)
            {
                SoundToast(player, string.Format(lang.GetMessage("ReportCooldown", this, steamid), Mathf.CeilToInt(config.ReportCooldown - (now - last))), 1);
                return;
            }

            DrawReportInterface(player);
        }

        // NOTE: the ConsoleSystem.Arg overload is deliberately not used here.
        // Current Rust versions expose console arguments as a StringView[] (a value type),
        // which cannot be treated as string[] - using it breaks compilation of the plugin.
        // This covalence overload receives already parsed string arguments on every game version.
        private object OnServerCommand(string command, string[] args)
        {
            if (!config.AutoParseF7Reports || string.IsNullOrEmpty(command))
            {
                return null;
            }
            if (!command.EndsWith("report", StringComparison.OrdinalIgnoreCase))
            {
                return null;
            }

            try
            {
                var parts = new List<string>();
                if (args != null)
                {
                    foreach (string arg in args)
                    {
                        if (!string.IsNullOrEmpty(arg))
                        {
                            parts.Add(arg);
                        }
                    }
                }

                // Some uMod versions pass the command name itself as the first argument
                if (parts.Count > 0 && parts[0].Equals("report", StringComparison.OrdinalIgnoreCase))
                {
                    parts.RemoveAt(0);
                }

                string target = parts.Count > 0 ? parts[0] : null;
                string reason = parts.Count > 1 ? string.Join(" ", parts.Skip(1)) : null;

                PInfo targetPlayer = FindTarget(target);
                var report = new JObject
                {
                    ["reporter_steamid"] = null,
                    ["reporter_name"] = "F7 report",
                    ["target_steamid"] = targetPlayer?.Id ?? target,
                    ["target_name"] = targetPlayer?.Name ?? (target ?? "Unknown"),
                    ["reason"] = string.IsNullOrEmpty(reason) ? "F7 report" : reason,
                    ["source"] = "f7",
                    ["status"] = "pending",
                    ["created_at"] = DateTime.UtcNow.ToString("o", CultureInfo.InvariantCulture)
                };
                Post("/rest/v1/reports", report.ToString());
                InsertAlert("report", $"F7 report: {targetPlayer?.Name ?? target} - {reason}");
                LogCommand($"F7 report: {target} - {reason}");
            }
            catch (Exception ex)
            {
                PrintError($"F7 report parse error: {ex.Message}");
            }

            return null;
        }

        [ChatCommand("contact")]
        private void CmdContact(BasePlayer player, string command, string[] args)
        {
            if (player == null)
            {
                return;
            }

            string sid = player.UserIDString;

            // No arguments: just show the Discord/contact message.
            if (args == null || args.Length == 0)
            {
                SendMessage(player, string.IsNullOrEmpty(config.ContactMessage) ? lang.GetMessage("Contact.Error", this, sid) : config.ContactMessage);
                return;
            }

            string contact = string.Join(" ", args);

            // Save the contact into the active verification session so the admin
            // sees it in the panel's check chat.
            long? checkId = GetActiveCheckId(sid);
            if (checkId.HasValue)
            {
                AddCheckEvent(checkId.Value, "contact", $"discord: {contact}");
            }

            SendMessage(player, lang.GetMessage("Contact.Sent", this, sid) + $"<color=#8393cd> {contact}</color>");
            SendMessage(player, lang.GetMessage("Contact.SentWait", this, sid));
        }

        private static List<string> ParseQuoted(string s)
        {
            var result = new List<string>();
            if (string.IsNullOrEmpty(s))
            {
                return result;
            }
            int i = 0;
            while (i < s.Length)
            {
                while (i < s.Length && s[i] == ' ')
                {
                    i++;
                }
                if (i >= s.Length)
                {
                    break;
                }
                if (s[i] == '"')
                {
                    i++;
                    int start = i;
                    while (i < s.Length && s[i] != '"')
                    {
                        i++;
                    }
                    result.Add(s.Substring(start, i - start));
                    if (i < s.Length && s[i] == '"')
                    {
                        i++;
                    }
                }
                else
                {
                    int start = i;
                    while (i < s.Length && s[i] != ' ')
                    {
                        i++;
                    }
                    result.Add(s.Substring(start, i - start));
                }
            }
            return result;
        }

        #endregion

        #region Logging inserts

        private void InsertChatLog(PInfo iPlayer, string message)
        {
            var body = new JObject
            {
                ["steamid"] = iPlayer.Id,
                ["name"] = iPlayer.Name,
                ["message"] = message,
                ["created_at"] = DateTime.UtcNow.ToString("o", CultureInfo.InvariantCulture)
            };
            Post("/rest/v1/chat_logs", body.ToString());
        }

        private void InsertConnectionLog(string steamid, string name, string ip, string type)
        {
            var body = new JObject
            {
                ["steamid"] = steamid,
                ["name"] = name,
                ["ip"] = ip,
                ["type"] = type,
                ["created_at"] = DateTime.UtcNow.ToString("o", CultureInfo.InvariantCulture)
            };
            Post("/rest/v1/connection_logs", body.ToString());
        }

        private void InsertKick(PInfo iPlayer, string reason, string admin)
        {
            var body = new JObject
            {
                ["steamid"] = iPlayer.Id,
                ["name"] = iPlayer.Name,
                ["reason"] = reason,
                ["admin"] = admin,
                ["created_at"] = DateTime.UtcNow.ToString("o", CultureInfo.InvariantCulture)
            };
            Post("/rest/v1/kicks", body.ToString());
        }

        // Feeds the "Alerts" (Оповещения) tab: noteworthy server events.
        private void InsertAlert(string kind, string text)
        {
            try
            {
                var body = new JObject
                {
                    ["kind"] = kind,
                    ["text"] = text,
                    ["created_at"] = DateTime.UtcNow.ToString("o", CultureInfo.InvariantCulture)
                };
                Post("/rest/v1/alerts", body.ToString());
            }
            catch { }
        }

        private void LogCommand(string message)
        {
            var body = new JObject
            {
                ["steamid"] = "server",
                ["name"] = "server",
                ["message"] = message,
                ["created_at"] = DateTime.UtcNow.ToString("o", CultureInfo.InvariantCulture)
            };
            Post("/rest/v1/chat_logs", body.ToString());
            Puts(message);
        }

        #endregion

        #region Util

        private static long ToUnixTime(DateTime dt)
        {
            return new DateTimeOffset(dt).ToUnixTimeSeconds();
        }

        // Supabase returns timestamps with an explicit offset (e.g. "...+00:00").
        // Casting such a token straight to DateTime yields local time, which breaks
        // expiry comparisons on servers outside UTC, so normalize everything to UTC.
        private static DateTime? ParseUtcDate(JToken token)
        {
            if (token == null || token.Type == JTokenType.Null)
            {
                return null;
            }
            try
            {
                if (token.Type == JTokenType.Date)
                {
                    return ((DateTime)token).ToUniversalTime();
                }

                const DateTimeStyles style = DateTimeStyles.AdjustToUniversal | DateTimeStyles.AssumeUniversal;
                string value = token.ToString();
                if (DateTime.TryParseExact(value, "o", CultureInfo.InvariantCulture, style, out DateTime exact))
                {
                    return exact;
                }
                if (DateTime.TryParse(value, CultureInfo.InvariantCulture, style, out DateTime parsed))
                {
                    return parsed;
                }
            }
            catch { }
            return null;
        }

        #endregion
    }
}
