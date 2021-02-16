const AWS = require('aws-sdk')
const { sleep, getNakedDomain } = require('./utils')
const getDomainHostedZoneId = require('./getDomainHostedZoneId')

const getCertificateArnByDomain = async (acm, nakedDomain) => {
  const listRes = await acm.listCertificates().promise()
  const certificate = listRes.CertificateSummaryList.find((cert) => cert.DomainName === nakedDomain)
  return certificate && certificate.CertificateArn ? certificate.CertificateArn : null
}

const getCertificateValidationRecord = (certificate, domain) => {
  if (!certificate.DomainValidationOptions) {
    return null
  }
  const domainValidationOption = certificate.DomainValidationOptions.find(
    (option) => option.DomainName === domain
  )

  return domainValidationOption.ResourceRecord
}

const describeCertificateByArn = async (acm, certificateArn, nakedDomain) => {
  const res = await acm.describeCertificate({ CertificateArn: certificateArn }).promise()
  const certificate = res && res.Certificate ? res.Certificate : null

  if (
    certificate.Status === 'PENDING_VALIDATION' &&
    !getCertificateValidationRecord(certificate, nakedDomain)
  ) {
    await sleep(1000)
    return describeCertificateByArn(acm, certificateArn, nakedDomain)
  }

  return certificate
}

module.exports = async (config, params = {}) => {
  params.log = params.log || (() => { })
  const { log } = params
  const nakedDomain = getNakedDomain(params.domain)
  const wildcardSubDomain = `*.${nakedDomain}`
  const { domainHostedZoneId } = await getDomainHostedZoneId(config, params)

  const acm = new AWS.ACM(config)
  const route53 = new AWS.Route53(config)

  const certificateParams = {
    DomainName: nakedDomain,
    SubjectAlternativeNames: [nakedDomain, wildcardSubDomain],
    ValidationMethod: 'DNS'
  }

  log(`Checking if a certificate for the ${nakedDomain} domain exists`)
  let certificateArn = await getCertificateArnByDomain(acm, nakedDomain)

  if (!certificateArn) {
    log(`Certificate for the ${nakedDomain} domain does not exist. Creating...`)
    certificateArn = (await acm.requestCertificate(certificateParams).promise()).CertificateArn
  }

  const certificate = await describeCertificateByArn(acm, certificateArn, nakedDomain)

  log(`Certificate for ${nakedDomain} is in a "${certificate.Status}" status`)

  if (certificate.Status === 'PENDING_VALIDATION') {
    const certificateValidationRecord = getCertificateValidationRecord(certificate, nakedDomain)
    // only validate if domain/hosted zone is found in this account
    if (domainHostedZoneId) {
      log(`Validating the certificate for the ${nakedDomain} domain.`)

      const recordParams = {
        HostedZoneId: domainHostedZoneId,
        ChangeBatch: {
          Changes: [
            {
              Action: 'UPSERT',
              ResourceRecordSet: {
                Name: certificateValidationRecord.Name,
                Type: certificateValidationRecord.Type,
                TTL: 300,
                ResourceRecords: [
                  {
                    Value: certificateValidationRecord.Value
                  }
                ]
              }
            }
          ]
        }
      }
      await route53.changeResourceRecordSets(recordParams).promise()
      log(
        `Your certificate was created and is being validated. It may take a few mins to validate.`
      )
      log(
        `Please deploy again after few mins to use your newly validated certificate and activate your domain.`
      )
    } else {
      // if domain is not in account, let the user validate manually
      log(
        `Certificate for the ${nakedDomain} domain was created, but not validated. Please validate it manually.`
      )
      log(`Certificate Validation Record Name: ${certificateValidationRecord.Name} `)
      log(`Certificate Validation Record Type: ${certificateValidationRecord.Type} `)
      log(`Certificate Validation Record Value: ${certificateValidationRecord.Value} `)
    }
  }

  return {
    domainHostedZoneId,
    certificateArn,
    certificateStatus: certificate.Status
  }
}
