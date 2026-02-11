import fs from 'fs'
import YAML from 'yaml'
import path from 'path'
import _ from 'lodash' // Yunzai 自带 lodash，直接引即可

const pluginName = 'Huitian-mini' // 如果你的文件夹名字不同，请修改这里
const pluginPath = path.join(process.cwd(), 'plugins', pluginName)
const defPath = path.join(pluginPath, 'config', 'default.yaml')
const userPath = path.join(pluginPath, 'config', 'config.yaml')

class Config {
  constructor() {
    this.init()
  }

  // 初始化：检测并自动生成用户配置文件
  init() {
    const configDir = path.join(pluginPath, 'config')
    if (!fs.existsSync(configDir)) {
      fs.mkdirSync(configDir)
    }
    // 如果用户配置不存在，而默认配置存在，则复制一份给用户
    if (!fs.existsSync(userPath) && fs.existsSync(defPath)) {
      try {
        fs.copyFileSync(defPath, userPath)
      } catch (err) {
        console.error(`[${pluginName}] 创建默认配置文件失败`, err)
      }
    }
  }

  /**
   * 获取配置参数
   * @param {string} app 模块名，对应 yaml 中的顶层 key (如 'daily', 'mys_cos')
   * @returns {object} 返回合并后的配置对象
   */
  get(app) {
    let defData = {}
    let userData = {}

    try {
      if (fs.existsSync(defPath)) {
        defData = YAML.parse(fs.readFileSync(defPath, 'utf8')) || {}
      }
      if (fs.existsSync(userPath)) {
        userData = YAML.parse(fs.readFileSync(userPath, 'utf8')) || {}
      }
    } catch (e) {
      console.error(`[${pluginName}] YAML 格式解析错误，请检查配置文件:`, e.message)
    }

    // 深合并：以 defData 为基础，userData 中的同名配置会覆盖它
    const config = _.merge({}, defData, userData)
    
    return app ? (config[app] || {}) : config
  }
}

export default new Config()