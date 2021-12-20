import { Bee, Utils } from '@ethersphere/bee-js'
import { Bytes } from '@ethersphere/bee-js/dist/src/utils/bytes'
import { randomBytes } from 'crypto'
import Wallet from 'ethereumjs-wallet'
import React, { ChangeEvent, FormEvent, useEffect, useState } from 'react'
import { Button, Col, Container, Form, FormControl, InputGroup, Row, Spinner, Stack } from 'react-bootstrap'
import './App.css'

/** Handled by the gateway proxy or swarm-extension */
const STAMP_ID = '0000000000000000000000000000000000000000000000000000000000000000'

interface MessageFormat {
  timestamp: number
  message: string
}

interface MessageBoxProps {
  date: Date
  text: string
  position: 'left' | 'right'
}

function makeBytes<Length extends number>(length: Length): Bytes<Length> {
  return new Uint8Array(length) as Bytes<Length>
}

async function saveLocalStorage(key: string, value: string): Promise<void> {
  if (window.swarm && window.origin === 'null') {
    await window.swarm.localStorage.setItem(key, value)
  } else {
    window.localStorage.setItem(key, value)
  }
}

async function loadLocalStorage(key: string): Promise<string | null> {
  if (window.swarm && window.origin === 'null') {
    const item = await window.swarm.localStorage.getItem(key)

    return item
  } else {
    return window.localStorage.getItem(key)
  }
}

function fetchIndexToInt(fetchIndex: string): number {
  const indexBytes = Utils.hexToBytes(fetchIndex)
  let index = 0
  for (let i = indexBytes.length - 1; i >= 0; i--) {
    const byte = indexBytes[i]

    if (byte === 0) break

    index += byte
  }

  return index
}

function writeUint64BigEndian(value: number, bytes: Bytes<8> = makeBytes(8)): Bytes<8> {
  const dataView = new DataView(bytes.buffer)
  const valueLower32 = value & 0xffffffff

  dataView.setUint32(0, 0)
  dataView.setUint32(4, valueLower32)

  return bytes
}

/** it gives back SOC identifiers of older feed updates from the given `fromIndex` */
function previousIdentifiers(topic: Utils.Bytes<32>, fromIndex: number, maxPreviousUpdates = 3): Utils.Bytes<32>[] {
  const identifiers: Utils.Bytes<32>[] = []
  for (
    let updateIndex = fromIndex - 1;
    updateIndex >= 0 && fromIndex - updateIndex <= maxPreviousUpdates;
    updateIndex--
  ) {
    const indexBytes = writeUint64BigEndian(updateIndex)
    identifiers.push(Utils.keccak256Hash(topic, indexBytes))
  }

  return identifiers
}

function encodeMessage(message: string, timeStamp?: number): Uint8Array {
  const messageFormat: MessageFormat = {
    timestamp: timeStamp || new Date().getTime(),
    message,
  }

  return new TextEncoder().encode(JSON.stringify(messageFormat))
}

function decodeMessage(data: Uint8Array): MessageFormat {
  const dataString = new TextDecoder().decode(data)
  try {
    const jsonData: MessageFormat = JSON.parse(dataString)

    return jsonData
  } catch (e) {
    console.error('wrong datastring to decode JSON message body', dataString)
    throw e
  }
}

function App() {
  // # nugaon # mollas # metacertain
  // default bee is pointing to the gateway
  const [bee, setBee] = useState<Bee>(new Bee('https://bee-9.gateway.ethswarm.org'))
  const [privkey, setPrivkey] = useState<Uint8Array>(randomBytes(32))
  const [wallet, setWallet] = useState<Wallet>(new Wallet())
  const [otherEthAddress, setOtherEthAddress] = useState<string | null>(null)
  const [message, setMessage] = useState<string>('')
  const [otherMessages, setOtherMessages] = useState<MessageFormat[]>([])
  const [myMessages, setMyMessages] = useState<MessageFormat[]>([])
  const [listMessages, setListMessages] = useState<MessageBoxProps[]>([])
  const [myEthAddress, setMyEthAddress] = useState<string>('')
  const [loadSendMessage, setLoadSendMessage] = useState<boolean>(false)
  const [loadListMessages, setLoadListMessages] = useState<boolean>(false)
  let otherLastFetchIndex = 0
  let mineLastFetchIndex = 0

  async function sendButtonOnClick(e: FormEvent) {
    e.preventDefault()

    if (!otherEthAddress) {
      console.error('nincs keyed haver')

      return
    }

    if (!message) {
      console.error('no message')

      return
    }

    setLoadSendMessage(true)
    const hashTopic = Utils.keccak256Hash(Utils.hexToBytes(otherEthAddress))
    const feedWriter = bee.makeFeedWriter('sequence', hashTopic, privkey)
    const messageFormat: MessageFormat = {
      message,
      timestamp: new Date().getTime(),
    }
    const { reference } = await bee.uploadData(STAMP_ID, encodeMessage(messageFormat.message, messageFormat.timestamp))
    console.log('uploaded swarm reference of the message', reference)
    const result = await feedWriter.upload(STAMP_ID, reference)

    console.log('feed upload', result)
    setMessage('')
    setMyMessages([...myMessages, messageFormat])
    setLoadSendMessage(false)
  }

  async function refreshOthersMessage() {
    if (!otherEthAddress || otherEthAddress.length === 0) {
      console.error('nincs keyed haver')

      return
    }

    setLoadListMessages(true)
    const myEthAddress = wallet.getAddress()
    const hashTopicAtBro = Utils.keccak256Hash(myEthAddress)
    const feedReaderBro = bee.makeFeedReader('sequence', hashTopicAtBro, otherEthAddress)
    try {
      const latestBro = await feedReaderBro.download()

      // fetch older messages
      // from the other guy
      let fetchCount = fetchIndexToInt(latestBro.feedIndex) - otherLastFetchIndex

      if (fetchCount > 3) fetchCount = 3
      otherLastFetchIndex = fetchIndexToInt(latestBro.feedIndex)
      await saveLocalStorage('other_last_fetch_index', String(otherLastFetchIndex))

      const otherOlderMessages: MessageFormat[] = []
      const socReader = bee.makeSOCReader(otherEthAddress)
      const identifiers = previousIdentifiers(hashTopicAtBro, fetchIndexToInt(latestBro.feedIndex), fetchCount)
      for (const identifier of identifiers) {
        const olderUpdatePayload = (await socReader.download(identifier)).payload()
        const olderMessageReferene = Utils.bytesToHex(olderUpdatePayload.slice(-32))
        const bytes = await bee.downloadData(olderMessageReferene)
        otherOlderMessages.push(decodeMessage(bytes))
      }
      //download latest message
      const bytes = await bee.downloadData(latestBro.reference)
      const othersLatestMessage = decodeMessage(bytes)
      setOtherMessages([...otherOlderMessages, othersLatestMessage])
    } catch (e) {
      console.log('No latest message from bro', e)
    }

    // from me
    if (myMessages.length === 0) {
      //latest mine
      const hashTopicAtMine = Utils.keccak256Hash(Utils.hexToBytes(otherEthAddress))
      const feedReaderMine = bee.makeFeedReader('sequence', hashTopicAtMine, myEthAddress)
      try {
        const latesMine = await feedReaderMine.download()

        let fetchCount = fetchIndexToInt(latesMine.feedIndex) - mineLastFetchIndex

        if (fetchCount > 3) fetchCount = 3
        mineLastFetchIndex = fetchIndexToInt(latesMine.feedIndex)
        await saveLocalStorage('mine_last_fetch_index', String(mineLastFetchIndex))

        const otherOlderMessages: MessageFormat[] = []
        const socReader = bee.makeSOCReader(myEthAddress)
        const identifiers = previousIdentifiers(hashTopicAtMine, fetchIndexToInt(latesMine.feedIndex), fetchCount)
        for (const identifier of identifiers) {
          const olderUpdatePayload = (await socReader.download(identifier)).payload()
          const olderMessageReferene = Utils.bytesToHex(olderUpdatePayload.slice(-32))
          const bytes = await bee.downloadData(olderMessageReferene)
          otherOlderMessages.push(decodeMessage(bytes))
        }

        const bytes = await bee.downloadData(latesMine.reference)
        const myLatestMessage = decodeMessage(bytes)
        setMyMessages([...otherOlderMessages, myLatestMessage])
      } catch (e) {
        console.log('No message from me', e)
      }
    }

    setLoadListMessages(false)
  }

  // constructor
  useEffect(() => {
    const setStringKey = (key: string) => {
      const keyBytes = Utils.hexToBytes(key)
      setByteKey(keyBytes)
    }

    /** bytes represent hex keys */
    const setByteKey = (keyBytes: Uint8Array) => {
      setPrivkey(keyBytes)
      const wallet = new Wallet(Buffer.from(keyBytes))
      setWallet(wallet)
      const address = Utils.bytesToHex(wallet.getAddress())
      console.log('set key', address)
      setMyEthAddress(address)
    }

    if (window.swarm && window.origin === 'null') {
      const beeUrl = window.swarm.web2Helper.fakeBeeApiAddress()
      setBee(new Bee(beeUrl))
      ;(async () => {
        //private key handling
        const windowPrivKey = await window.swarm.localStorage.getItem('private_key')

        if (windowPrivKey) {
          setStringKey(windowPrivKey)
        } else {
          const key = randomBytes(32)
          await window.swarm.localStorage.setItem('private_key', Utils.bytesToHex(key))
          setByteKey(key)
        }
        //last fetched index handling
        mineLastFetchIndex = Number(await window.swarm.localStorage.getItem('mine_last_fetch_index'))
        otherLastFetchIndex = Number(await window.swarm.localStorage.getItem('other_last_fetch_index'))
      })()
    } else {
      const windowPrivKey = window.localStorage.getItem('private_key')

      if (windowPrivKey) {
        setStringKey(windowPrivKey)
      } else {
        const key = randomBytes(32)
        window.localStorage.setItem('private_key', Utils.bytesToHex(key))
        setByteKey(key)
      }
      //last fetched index handling
      mineLastFetchIndex = Number(window.localStorage.getItem('mine_last_fetch_index'))
      otherLastFetchIndex = Number(window.localStorage.getItem('other_last_fetch_index'))
    }
  }, [])

  useEffect(() => {
    const otherMessagesInFormat: MessageBoxProps[] = otherMessages.map(m => {
      return {
        text: m.message,
        date: new Date(m.timestamp),
        position: 'right',
      }
    })
    const myMessagesInFormat: MessageBoxProps[] = myMessages.map(m => {
      return {
        text: m.message,
        date: new Date(m.timestamp),
        position: 'left',
      }
    })
    const messageList: MessageBoxProps[] = [...myMessagesInFormat, ...otherMessagesInFormat].sort(
      (a, b) => a.date!.getTime() - b.date!.getTime(),
    )

    setListMessages(messageList)
  }, [myMessages, otherMessages])

  const onEthAddressChange = (e: ChangeEvent<HTMLInputElement>) => {
    setOtherEthAddress(e.target.value)
    setMyMessages([])
    setOtherMessages([])
  }

  const onMessageChange = (e: ChangeEvent<HTMLInputElement>) => {
    setMessage(e.target.value)
  }

  return (
    <Container className="App" fluid>
      <div className="App-header">
        <h1 id="purityweb-logo" className="fadeInDown animated">
          EtherChat
        </h1>
      </div>

      <Container className="maincontent">
        <Stack gap={2}>
          <div>Your ETH address is</div>
          <div className="font-weight-bold">{myEthAddress}</div>
        </Stack>

        <hr />

        <Form.Label htmlFor="basic-url">Ethereum address of your chatpartner</Form.Label>
        <FormControl
          id="basic-url"
          aria-describedby="basic-addon3"
          value={otherEthAddress || ''}
          onChange={onEthAddressChange}
        />

        <hr />

        <div className="read">
          <div>
            <h3>Messages</h3>
            <Row>
              <Col style={{ textAlign: 'left', fontWeight: 'bold' }}>You</Col>
              <Col style={{ textAlign: 'right', fontWeight: 'bold' }}>Bro</Col>
            </Row>
            <div style={{ padding: '12px 0' }}>
              {listMessages.map(listMessage => (
                <div
                  key={`${listMessage.date}|${listMessage.position}`}
                  style={{ textAlign: listMessage.position, margin: '12px 0' }}
                >
                  <span
                    className={listMessage.position === 'right' ? 'bg-primary' : 'bg-secondary'}
                    style={{
                      borderRadius: 5,
                      padding: 5,
                    }}
                  >
                    {listMessage.text}
                  </span>
                </div>
              ))}
            </div>
            <div style={{ minHeight: 42 }}>
              <Spinner animation="grow" hidden={!loadListMessages} />
            </div>
            <Button onClick={refreshOthersMessage} className="refreshButton" disabled={loadListMessages}>
              Refresh
            </Button>
          </div>
        </div>

        <hr />

        <Form onSubmit={sendButtonOnClick}>
          <InputGroup>
            <FormControl
              aria-describedby="basic-addon2"
              value={message}
              onChange={onMessageChange}
              disabled={loadSendMessage}
            />
            <Button disabled={loadSendMessage} variant="outline-secondary primary" id="button-addon2" type="submit">
              Send{' '}
              <Spinner
                as="span"
                animation="border"
                size="sm"
                role="status"
                aria-hidden="true"
                variant="primary"
                hidden={!loadSendMessage}
              />
            </Button>
          </InputGroup>
        </Form>
      </Container>
    </Container>
  )
}

export default App
