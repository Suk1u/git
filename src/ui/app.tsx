import {
  NavigationStack,
  Script,
  Tab,
  TabView,
  useEffect,
  useObservable,
  useState,
} from "scripting"
import { loadSettings } from "../storage"
import { BrowseTab, HistoryTab, LibraryTab, SearchTab, SettingsTab } from "./tabs"

export function App() {
  const selection = useObservable<number>(1)
  const [settings, setSettings] = useState(loadSettings())

  useEffect(() => {
    const removeResume = Script.onResume(details => {
      if (details.resumeFromMinimized) setSettings(loadSettings())
    })
    const removeMinimize = Script.onMinimize(() => {
      console.log("琉璃漫画已最小化")
    })
    return () => {
      removeResume()
      removeMinimize()
    }
  }, [])

  return (
    <TabView
      selection={selection}
      tint="systemRed"
      tabBarMinimizeBehavior="onScrollDown"
      tabViewSearchActivation="searchTabSelection"
      frame={{ maxWidth: "infinity", maxHeight: "infinity" }}
      background="systemBackground"
      ignoresSafeArea={{ regions: "container", edges: "bottom" }}
    >
      <Tab title="书架" systemImage="books.vertical.fill" value={0}>
        <NavigationStack ignoresSafeArea={true}>
          <LibraryTab settings={settings} onSettingsChanged={setSettings} />
        </NavigationStack>
      </Tab>
      <Tab title="浏览" systemImage="globe" value={1}>
        <NavigationStack ignoresSafeArea={true}>
          <BrowseTab settings={settings} onSettingsChanged={setSettings} />
        </NavigationStack>
      </Tab>
      <Tab title="历史" systemImage="clock" value={2}>
        <NavigationStack ignoresSafeArea={true}>
          <HistoryTab settings={settings} onSettingsChanged={setSettings} />
        </NavigationStack>
      </Tab>
      <Tab title="设置" systemImage="gear" value={3}>
        <NavigationStack ignoresSafeArea={true}>
          <SettingsTab settings={settings} onSettingsChanged={setSettings} />
        </NavigationStack>
      </Tab>
      <Tab title="搜索" systemImage="magnifyingglass" value={4} role="search">
        <NavigationStack ignoresSafeArea={true}>
          <SearchTab settings={settings} onSettingsChanged={setSettings} />
        </NavigationStack>
      </Tab>
    </TabView>
  )
}
