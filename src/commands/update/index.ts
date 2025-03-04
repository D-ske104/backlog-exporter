import {Args, Command, Flags} from '@oclif/core'
import * as dotenv from 'dotenv'
import {access, readdir} from 'node:fs/promises'
import {join} from 'node:path'

import {downloadIssues, downloadWikis} from '../../utils/backlog-api.js'
import {validateAndGetProjectId} from '../../utils/backlog.js'
import {createOutputDirectory, getApiKey} from '../../utils/common.js'
import {FolderType, getSettingsFilePath, loadSettings, updateSettings} from '../../utils/settings.js'

// .envファイルを読み込む
dotenv.config()

// フラグの型定義
interface UpdateFlags {
  apiKey?: string
  domain?: string
  force?: boolean
  issuesOnly?: boolean
  projectIdOrKey?: string
  wikisOnly?: boolean
}

export default class Update extends Command {
  static args = {
    directory: Args.string({
      description: '更新対象のディレクトリ（設定ファイルが保存されている場所）',
      required: false,
    }),
  }
  static description = 'Backlogから最新データを取得して更新する'
  static examples = [
    `<%= config.bin %> <%= command.id %>
カレントディレクトリの設定を使用して更新する
`,
    `<%= config.bin %> <%= command.id %> --force
確認プロンプトをスキップする
`,
    `<%= config.bin %> <%= command.id %> --apiKey YOUR_API_KEY --domain example.backlog.jp --projectIdOrKey PROJECT_KEY
指定したパラメータで更新する（設定ファイルが存在する場合は上書きされます）
`,
    `<%= config.bin %> <%= command.id %> ./my-project
指定したディレクトリの設定を使用して更新する
`,
  ]
  static flags = {
    apiKey: Flags.string({
      description: 'Backlog API key (環境変数 BACKLOG_API_KEY からも自動読み取り可能)',
      required: false,
    }),
    domain: Flags.string({
      description: 'Backlog domain (e.g. example.backlog.jp)',
      required: false,
    }),
    force: Flags.boolean({
      char: 'f',
      description: '確認プロンプトをスキップする',
      required: false,
    }),
    issuesOnly: Flags.boolean({
      description: '課題のみを更新する',
      required: false,
    }),
    projectIdOrKey: Flags.string({
      description: 'Backlog project ID or key',
      required: false,
    }),
    wikisOnly: Flags.boolean({
      description: 'Wikiのみを更新する',
      required: false,
    }),
  }

  async run(): Promise<void> {
    const {args, flags} = await this.parse(Update)

    // 更新対象のディレクトリを決定（指定がなければカレントディレクトリ）
    const targetDir = args.directory || process.cwd()

    try {
      // 設定ファイルを探索して更新を実行
      await this.findAndUpdateSettings(targetDir, flags as UpdateFlags)
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error)
      this.error(`更新に失敗しました: ${errorMessage}`)
    }
  }

  // 確認プロンプトの表示
  private async confirmUpdate(options: {
    domain: string
    folderType?: FolderType
    force: boolean
    projectIdOrKey: string
    targetDir: string
    updateIssues: boolean
    updateWikis: boolean
  }): Promise<boolean> {
    if (options.force) return true

    this.log(`以下の設定で更新を実行します:`)
    this.log(`- ディレクトリ: ${options.targetDir}`)
    this.log(`- ドメイン: ${options.domain}`)
    this.log(`- プロジェクト: ${options.projectIdOrKey}`)

    if (options.folderType) {
      this.log(`- フォルダタイプ: ${options.folderType}`)
    }

    this.log(
      `- 更新対象: ${options.updateIssues ? '課題' : ''}${options.updateIssues && options.updateWikis ? 'と' : ''}${
        options.updateWikis ? 'Wiki' : ''
      }`,
    )

    // 確認プロンプトを表示
    this.log('更新を実行しますか？ (y/n)')
    process.stdin.resume()
    process.stdin.setEncoding('utf8')
    const response = await new Promise<boolean>((resolve) => {
      process.stdin.once('data', (data) => {
        const input = data.toString().trim().toLowerCase()
        resolve(input === 'y' || input === 'yes')
        process.stdin.pause()
      })
    })

    if (!response) {
      this.log('更新をキャンセルしました')
    }

    return response
  }

  // 更新対象の決定
  private determineUpdateTargets(
    folderType: FolderType | undefined,
    issuesOnly: boolean | undefined,
    wikisOnly: boolean | undefined,
  ): {
    updateIssues: boolean
    updateWikis: boolean
  } {
    let updateIssues = !wikisOnly
    let updateWikis = !issuesOnly

    // フォルダタイプがISSUEの場合は課題のみ更新
    if (folderType === FolderType.ISSUE) {
      updateIssues = true
      updateWikis = false
    }
    // フォルダタイプがWIKIの場合はWikiのみ更新
    else if (folderType === FolderType.WIKI) {
      updateIssues = false
      updateWikis = true
    }

    return {updateIssues, updateWikis}
  }

  // 設定ファイルを探索して更新を実行
  private async findAndUpdateSettings(targetDir: string, flags: UpdateFlags): Promise<void> {
    // 現在のディレクトリに設定ファイルがあるか確認
    const settingsPath = getSettingsFilePath(targetDir)
    let hasSettings = false

    try {
      await access(settingsPath)
      hasSettings = true
    } catch {
      // 設定ファイルが存在しない場合は何もしない
    }

    if (hasSettings) {
      // 設定ファイルが存在する場合は更新を実行
      await this.updateDirectory(targetDir, flags)
    }

    // サブディレクトリを探索
    try {
      const entries = await readdir(targetDir, {withFileTypes: true})

      for (const entry of entries) {
        if (entry.isDirectory()) {
          const subDir = join(targetDir, entry.name)
          // eslint-disable-next-line no-await-in-loop
          await this.findAndUpdateSettings(subDir, flags)
        }
      }
    } catch {
      this.warn(`ディレクトリの読み取りに失敗しました: ${targetDir}`)
    }
  }

  // 指定されたディレクトリの更新を実行
  private async updateDirectory(targetDir: string, flags: UpdateFlags): Promise<void> {
    // 設定ファイルを読み込む
    const settings = await loadSettings(targetDir)

    // コマンドライン引数と設定ファイルを組み合わせて使用する値を決定
    const apiKey = flags.apiKey || settings.apiKey || getApiKey(this)
    const domain = flags.domain || settings.domain
    const projectIdOrKey = flags.projectIdOrKey || settings.projectIdOrKey
    const {folderType} = settings
    const {force, issuesOnly, wikisOnly} = flags

    // 必須パラメータの検証
    if (!domain) {
      this.warn(`${targetDir}: ドメインが指定されていません。スキップします。`)
      return
    }

    if (!projectIdOrKey) {
      this.warn(`${targetDir}: プロジェクトIDまたはキーが指定されていません。スキップします。`)
      return
    }

    // 更新対象の決定
    const {updateIssues, updateWikis} = this.determineUpdateTargets(folderType, issuesOnly, wikisOnly)

    // 更新前の確認
    const confirmed = await this.confirmUpdate({
      domain,
      folderType,
      force: force || false,
      projectIdOrKey,
      targetDir,
      updateIssues,
      updateWikis,
    })
    if (!confirmed) return

    // 出力ディレクトリの作成
    await createOutputDirectory(targetDir)

    // プロジェクトキーからプロジェクトIDを取得
    const projectId = await validateAndGetProjectId(domain, projectIdOrKey, apiKey)
    this.log(`プロジェクトID: ${projectId} を使用します`)

    // 課題の更新
    if (updateIssues) {
      await this.updateIssues({
        apiKey,
        domain,
        projectId,
        projectIdOrKey,
        targetDir,
      })
    }

    // Wikiの更新
    if (updateWikis) {
      await this.updateWikis({
        apiKey,
        domain,
        projectIdOrKey,
        targetDir,
      })
    }

    this.log(`${targetDir} の更新が完了しました！`)
  }

  // 課題の更新
  private async updateIssues(options: {
    apiKey: string
    domain: string
    projectId: number
    projectIdOrKey: string
    targetDir: string
  }): Promise<void> {
    this.log('課題の更新を開始します...')

    // 設定ファイルから前回の更新日時を取得
    const {lastUpdated} = await loadSettings(options.targetDir)

    await downloadIssues(this, {
      apiKey: options.apiKey,
      count: 100,
      domain: options.domain,
      lastUpdated,
      outputDir: options.targetDir,
      projectId: options.projectId,
    })

    // 設定ファイルを更新
    await updateSettings(options.targetDir, {
      apiKey: options.apiKey,
      domain: options.domain,
      folderType: FolderType.ISSUE,
      lastUpdated: new Date().toISOString(),
      outputDir: options.targetDir,
      projectIdOrKey: options.projectIdOrKey,
    })

    this.log('課題の更新が完了しました')
  }

  // Wikiの更新
  private async updateWikis(options: {
    apiKey: string
    domain: string
    projectIdOrKey: string
    targetDir: string
  }): Promise<void> {
    this.log('Wikiの更新を開始します...')

    // 設定ファイルから前回の更新日時を取得
    const {lastUpdated} = await loadSettings(options.targetDir)

    await downloadWikis(this, {
      apiKey: options.apiKey,
      domain: options.domain,
      lastUpdated,
      outputDir: options.targetDir,
      projectIdOrKey: options.projectIdOrKey,
    })

    // 設定ファイルを更新
    await updateSettings(options.targetDir, {
      apiKey: options.apiKey,
      domain: options.domain,
      folderType: FolderType.WIKI,
      lastUpdated: new Date().toISOString(),
      outputDir: options.targetDir,
      projectIdOrKey: options.projectIdOrKey,
    })

    this.log('Wikiの更新が完了しました')
  }
}
