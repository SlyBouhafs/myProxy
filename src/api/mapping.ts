/* eslint @typescript-eslint/camelcase: 0 */
import express from 'express'
import uuid4 from 'uuid/v4'
import util from 'util'
import cp from 'child_process'
import { setData, getMappings } from '../lib/data'
import { Mapping } from '../types/general'
import prodConfigure from '../../scripts/prod.config.js'
import { getGitUserId } from '../helpers/getGitUser'
import environment from '../helpers/environment'
const mappingRouter = express.Router()
const exec = util.promisify(cp.exec)
const getNextPort = (map, start = 3002): number => {
  if (!map[start]) return start
  if (map[start]) start += 1
  return getNextPort(map, start)
}

const { WORKPATH, isProduction } = environment

mappingRouter.post('/', async (req, res) => {
  const domainKeys = getMappings()
  if (parseInt(req.body.port) < 3001) {
    return res.status(400).json({ message: 'Port cannot be smaller than 3001' })
  }
  const fullDomain = req.body.subDomain
    ? `${req.body.subDomain}.${req.body.domain}`
    : `${req.body.domain}`
  const existingSubDomain = domainKeys.find(e => e.fullDomain === fullDomain)
  if (existingSubDomain)
    return res.status(400).json({
      message: 'Subdomain already exists'
    })
  const map = domainKeys.reduce((acc, e) => {
    acc[e.port] = true
    return acc
  }, {})
  const portCounter = getNextPort(map)
  const prodConfigApp = [...prodConfigure.apps][0]
  prodConfigApp.name = fullDomain
  prodConfigApp.env_production.PORT = parseInt(req.body.port || portCounter, 10)
  prodConfigApp.script = 'npm'
  prodConfigApp.args = 'run start:myproxy'
  const prodConfig = {
    apps: prodConfigApp
  }
  const scriptPath = '.scripts'

  const respond = (): void => {
    const mappingObject: Mapping = {
      domain: req.body.domain,
      subDomain: req.body.subDomain,
      port: req.body.port || `${portCounter}`,
      ip: req.body.ip || '127.0.0.1',
      id: uuid4(),
      gitLink: `myproxy@${req.body.domain}:${WORKPATH}/${fullDomain}`,
      fullDomain
    }
    domainKeys.push(mappingObject)
    setData('mappings', domainKeys)
    res.json(mappingObject)
  }

  if (!isProduction()) {
    return respond()
  }
  const gitUserId = await getGitUserId()
  exec(
    `
      cd ${WORKPATH}
      mkdir ${fullDomain}
      git init ${fullDomain}
      cp ${scriptPath}/post-receive ${fullDomain}/.git/hooks/
      cp ${scriptPath}/pre-receive ${fullDomain}/.git/hooks/
      cp ${scriptPath}/.gitignore ${fullDomain}/.gitignore
      cd ${fullDomain}
      git config user.email "root@ipaddress"
      git config user.name "user"
      echo 'module.exports = ${JSON.stringify(prodConfig)}' > deploy.config.js
      git add .
      git commit -m "Initial Commit"
      `,
    { uid: gitUserId }
  ).then(() => {
    respond()
  })
})

mappingRouter.get('/', (req, res) => {
  const domains = getMappings()
  res.json(domains)
})

mappingRouter.delete('/delete/:id', async (req, res) => {
  const domains = getMappings()
  const deletedDomain = domains.find(e => e.id === req.params.id)
  const updatedDomains = domains.filter(e => {
    return e.id !== req.params.id
  })
  setData('mappings', updatedDomains)
  if (!isProduction()) {
    return res.json(deletedDomain)
  }
  const gitUserId = await getGitUserId()
  exec(
    `
      cd ${WORKPATH}
      export PM2_HOME=/home/myproxy/.pm2
      if command ls ${deletedDomain.fullDomain} | grep "package.json" &>/dev/null; then
      pm2 delete ${deletedDomain.fullDomain}
      fi
      rm -rf ${deletedDomain.fullDomain}
    `,
    { uid: gitUserId }
  ).then(() => {
    res.json(deletedDomain)
  })
})

mappingRouter.get('/download', (req, res) => {
  const filePath = `${WORKPATH}/${req.query.fullDomain}/deploy.config.js`
  res.setHeader('Content-disposition', 'attachment; filename=deploy.config.js')
  res.setHeader('Content-type', 'application/javascript')
  res.download(filePath, err => {
    console.log('Failed to download file', err)
  })
})

mappingRouter.get('/:id', (req, res) => {
  const domains = getMappings()
  const foundDomain = domains.find(e => e.id === req.params.id)
  res.json(foundDomain || {})
})

export default mappingRouter
